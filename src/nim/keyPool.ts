/**
 * NIM API key pool.
 *
 * Owns the lifecycle of every configured NVIDIA key: selection, health,
 * cooldown, circuit breaking and statistics. It is deliberately transport
 * agnostic — it hands out a key, is told how the attempt went, and decides what
 * to do next. `NimClient` performs the actual gRPC call.
 *
 * Design notes
 * ────────────
 * • A key is never removed permanently for a transient fault. 429s and 5xx put
 *   it into a bounded cooldown; only an auth rejection disables it outright.
 * • Cooldowns are exponential in the number of *consecutive* failures, so a key
 *   that is merely busy recovers fast while a key that is genuinely broken backs
 *   off hard.
 * • `inFlight` is tracked so `least-used` spreads concurrent load rather than
 *   piling every parallel request onto whichever key currently has the lowest
 *   lifetime count.
 */
import { createLogger } from '../utils/logger.js';
import type { NimKeyConfig } from '../config/index.js';
import type { BalancingStrategy, FailureKind, KeyState, KeyStats } from './types.js';

const log = createLogger('nim:pool');

/** Latency EMA smoothing factor. Higher = more responsive to recent samples. */
const LATENCY_ALPHA = 0.3;

/** Cap on exponential cooldown growth, to keep a key from being parked forever. */
const MAX_COOLDOWN_MULTIPLIER = 16;

interface PoolKey {
  id: string;
  key: string;
  weight: number;
  state: KeyState;
  requests: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  lastLatencyMs: number;
  lastUsedAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  cooldownUntil: number | null;
  inFlight: number;
  /** Rolling counter of 429s, used for the coarse quota estimate. */
  rateLimitHits: number;
  /** Round-robin cursor support. */
  circuitOpenedAt: number | null;
}

export interface KeyPoolOptions {
  strategy: BalancingStrategy;
  cooldownMs: number;
  circuitFailureThreshold: number;
  circuitResetMs: number;
}

export class NoKeysAvailableError extends Error {
  constructor(
    message: string,
    /** Milliseconds until the soonest key becomes eligible, if any. */
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'NoKeysAvailableError';
  }
}

export class KeyPool {
  private readonly keys: PoolKey[];
  private readonly options: KeyPoolOptions;
  private cursor = 0;

  constructor(configs: NimKeyConfig[], options: KeyPoolOptions) {
    if (configs.length === 0) {
      throw new Error('KeyPool requires at least one key.');
    }
    this.options = options;
    this.keys = configs.map((c) => ({
      id: c.id,
      key: c.key,
      weight: c.weight,
      state: 'healthy' as KeyState,
      requests: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      avgLatencyMs: 0,
      lastLatencyMs: 0,
      lastUsedAt: null,
      lastErrorAt: null,
      lastError: null,
      cooldownUntil: null,
      inFlight: 0,
      rateLimitHits: 0,
      circuitOpenedAt: null,
    }));

    log.info(
      { keyCount: this.keys.length, strategy: options.strategy },
      'NIM key pool initialised',
    );
  }

  get size(): number {
    return this.keys.length;
  }

  /**
   * Refresh lifecycle state for a key: expire cooldowns and half-open circuits.
   * Called lazily on selection so there is no background timer to manage.
   */
  private refresh(k: PoolKey, now: number): void {
    if (k.state === 'cooling' && k.cooldownUntil !== null && now >= k.cooldownUntil) {
      k.state = 'healthy';
      k.cooldownUntil = null;
      log.debug({ keyId: k.id }, 'Key cooldown expired, back in rotation');
    }

    if (
      k.state === 'open' &&
      k.circuitOpenedAt !== null &&
      now - k.circuitOpenedAt >= this.options.circuitResetMs
    ) {
      // Half-open: allow one probe request through. A success closes the
      // circuit; a failure re-opens it with a fresh timer.
      k.state = 'healthy';
      k.circuitOpenedAt = null;
      k.consecutiveFailures = 0;
      log.info({ keyId: k.id }, 'Circuit breaker half-open, probing key');
    }
  }

  private eligible(now: number, exclude: ReadonlySet<string>): PoolKey[] {
    const out: PoolKey[] = [];
    for (const k of this.keys) {
      this.refresh(k, now);
      if (k.state === 'healthy' && !exclude.has(k.id)) out.push(k);
    }
    return out;
  }

  /**
   * Pick the next key to use.
   *
   * @param exclude Key ids already tried for the current logical request, so a
   *                retry never lands on the key that just failed.
   * @throws {NoKeysAvailableError} when every key is cooling, open or disabled.
   */
  acquire(exclude: ReadonlySet<string> = new Set()): { id: string; key: string } {
    const now = Date.now();
    const candidates = this.eligible(now, exclude);

    if (candidates.length === 0) {
      throw new NoKeysAvailableError(
        'All NIM keys are unavailable (cooling down, circuit-open or disabled).',
        this.soonestAvailableIn(now),
      );
    }

    const chosen = this.select(candidates);
    chosen.requests += 1;
    chosen.inFlight += 1;
    chosen.lastUsedAt = now;
    return { id: chosen.id, key: chosen.key };
  }

  private select(candidates: PoolKey[]): PoolKey {
    switch (this.options.strategy) {
      case 'round-robin': {
        // Cursor walks the whole pool so ordering stays stable even as the
        // eligible subset changes between calls.
        for (let i = 0; i < this.keys.length; i++) {
          this.cursor = (this.cursor + 1) % this.keys.length;
          const k = this.keys[this.cursor];
          if (k && candidates.includes(k)) return k;
        }
        return candidates[0]!;
      }

      case 'least-used': {
        // Prefer fewest in-flight, tie-break on fewest lifetime requests. This
        // spreads bursts evenly instead of hammering one "least used" key.
        return candidates.reduce((best, k) => {
          if (k.inFlight !== best.inFlight) return k.inFlight < best.inFlight ? k : best;
          return k.requests < best.requests ? k : best;
        });
      }

      case 'lowest-latency': {
        // Unmeasured keys (avg 0) sort first so every key gets sampled.
        return candidates.reduce((best, k) => {
          const kl = k.avgLatencyMs === 0 ? -1 : k.avgLatencyMs;
          const bl = best.avgLatencyMs === 0 ? -1 : best.avgLatencyMs;
          return kl < bl ? k : best;
        });
      }

      case 'weighted': {
        // Weighted random over configured weights.
        const total = candidates.reduce((s, k) => s + k.weight, 0);
        let roll = Math.random() * total;
        for (const k of candidates) {
          roll -= k.weight;
          if (roll <= 0) return k;
        }
        return candidates[candidates.length - 1]!;
      }

      default:
        return candidates[0]!;
    }
  }

  /**
   * Return a key without recording success or failure.
   *
   * For best-effort side calls (voice discovery) whose outcome says nothing
   * about whether the key can serve synthesis. Penalising a key for these would
   * cool the whole pool at boot if the auxiliary RPC simply is not routable.
   */
  release(keyId: string): void {
    const k = this.byId(keyId);
    if (!k) return;
    k.inFlight = Math.max(0, k.inFlight - 1);
  }

  /** Record a successful attempt and close any half-open circuit. */
  reportSuccess(keyId: string, latencyMs: number): void {
    const k = this.byId(keyId);
    if (!k) return;

    k.inFlight = Math.max(0, k.inFlight - 1);
    k.successes += 1;
    k.consecutiveFailures = 0;
    k.lastLatencyMs = latencyMs;
    k.avgLatencyMs =
      k.avgLatencyMs === 0
        ? latencyMs
        : LATENCY_ALPHA * latencyMs + (1 - LATENCY_ALPHA) * k.avgLatencyMs;

    if (k.state !== 'disabled') {
      k.state = 'healthy';
      k.cooldownUntil = null;
      k.circuitOpenedAt = null;
    }
  }

  /**
   * Record a failed attempt and apply the appropriate penalty.
   *
   * Auth failures disable the key permanently (until process restart or manual
   * `reset()`), because retrying a rejected credential only wastes requests.
   * Everything else gets an exponentially growing cooldown.
   */
  reportFailure(keyId: string, kind: FailureKind, message: string): void {
    const k = this.byId(keyId);
    if (!k) return;

    const now = Date.now();
    k.inFlight = Math.max(0, k.inFlight - 1);
    k.failures += 1;
    k.consecutiveFailures += 1;
    k.lastErrorAt = now;
    k.lastError = message.slice(0, 300);

    if (kind === 'unauthorized') {
      k.state = 'disabled';
      k.cooldownUntil = null;
      log.error({ keyId: k.id }, 'Key rejected by NVIDIA (auth) — disabled');
      return;
    }

    // `bad-request` is our bug, not the key's — do not penalise the key.
    if (kind === 'bad-request') {
      k.consecutiveFailures = Math.max(0, k.consecutiveFailures - 1);
      return;
    }

    if (kind === 'rate-limited') k.rateLimitHits += 1;

    if (k.consecutiveFailures >= this.options.circuitFailureThreshold) {
      k.state = 'open';
      k.circuitOpenedAt = now;
      k.cooldownUntil = null;
      log.warn(
        { keyId: k.id, consecutiveFailures: k.consecutiveFailures },
        'Circuit breaker opened for key',
      );
      return;
    }

    const multiplier = Math.min(
      2 ** (k.consecutiveFailures - 1),
      MAX_COOLDOWN_MULTIPLIER,
    );
    k.state = 'cooling';
    k.cooldownUntil = now + this.options.cooldownMs * multiplier;
    log.warn(
      { keyId: k.id, kind, cooldownMs: this.options.cooldownMs * multiplier },
      'Key cooling down',
    );
  }

  /** Milliseconds until the soonest key becomes eligible again, or null. */
  private soonestAvailableIn(now: number): number | null {
    let soonest: number | null = null;
    for (const k of this.keys) {
      let readyAt: number | null = null;
      if (k.state === 'cooling' && k.cooldownUntil !== null) readyAt = k.cooldownUntil;
      else if (k.state === 'open' && k.circuitOpenedAt !== null) {
        readyAt = k.circuitOpenedAt + this.options.circuitResetMs;
      }
      if (readyAt === null) continue;
      const delta = Math.max(0, readyAt - now);
      if (soonest === null || delta < soonest) soonest = delta;
    }
    return soonest;
  }

  private byId(id: string): PoolKey | undefined {
    return this.keys.find((k) => k.id === id);
  }

  /** Manually return a disabled or open key to rotation (used by /admin). */
  reset(keyId?: string): void {
    for (const k of this.keys) {
      if (keyId && k.id !== keyId) continue;
      k.state = 'healthy';
      k.cooldownUntil = null;
      k.circuitOpenedAt = null;
      k.consecutiveFailures = 0;
    }
    log.info({ keyId: keyId ?? 'all' }, 'Key state manually reset');
  }

  /** Snapshot for /status and analytics. Never exposes the secrets themselves. */
  stats(): KeyStats[] {
    const now = Date.now();
    return this.keys.map((k) => {
      this.refresh(k, now);
      return {
        id: k.id,
        state: k.state,
        weight: k.weight,
        requests: k.requests,
        successes: k.successes,
        failures: k.failures,
        consecutiveFailures: k.consecutiveFailures,
        avgLatencyMs: Math.round(k.avgLatencyMs),
        lastLatencyMs: k.lastLatencyMs,
        lastUsedAt: k.lastUsedAt,
        lastErrorAt: k.lastErrorAt,
        lastError: k.lastError,
        cooldownUntil: k.cooldownUntil,
        inFlight: k.inFlight,
        successRate: k.requests === 0 ? 1 : k.successes / k.requests,
        estimatedQuotaRemaining: null,
      };
    });
  }

  /** True when at least one key could serve a request right now. */
  hasCapacity(): boolean {
    return this.eligible(Date.now(), new Set()).length > 0;
  }
}
