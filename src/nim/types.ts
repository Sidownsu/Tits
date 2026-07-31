/** Shared types for the NIM subsystem. */

/** Balancing strategies supported by the key pool. */
export type BalancingStrategy =
  | 'round-robin'
  | 'least-used'
  | 'weighted'
  | 'lowest-latency';

/**
 * Lifecycle state of a single API key.
 *
 * - `healthy`    — eligible for selection.
 * - `cooling`    — hit a 429/5xx; excluded until `cooldownUntil` passes.
 * - `open`       — circuit breaker tripped after repeated failures.
 * - `disabled`   — rejected by the API (401/403); excluded until manual reset.
 */
export type KeyState = 'healthy' | 'cooling' | 'open' | 'disabled';

export interface KeyStats {
  id: string;
  state: KeyState;
  weight: number;
  requests: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  /** Exponential moving average of round-trip latency, milliseconds. */
  avgLatencyMs: number;
  lastLatencyMs: number;
  lastUsedAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  cooldownUntil: number | null;
  /** In-flight requests currently assigned to this key. */
  inFlight: number;
  successRate: number;
  /**
   * Best-effort remaining-quota estimate. NVIDIA does not return quota headers
   * on the TTS path, so this is derived from observed 429s rather than measured.
   * Treat as a hint for operators, not a hard number.
   */
  estimatedQuotaRemaining: number | null;
}

export interface SynthesisRequest {
  text: string;
  /** Full Riva voice name, e.g. `Magpie-Multilingual.EN-US.Mia.Calm`. */
  voiceName: string;
  /** BCP-47 locale matching the voice, e.g. `en-US`. */
  languageCode: string;
  sampleRateHz?: number;
  /** Correlation id for tracing this synthesis across subsystems. */
  requestId?: string;
}

export interface SynthesisResult {
  /** Raw LINEAR_PCM (16-bit signed LE, mono) at `sampleRateHz`. */
  audio: Buffer;
  sampleRateHz: number;
  /** Which pool key served the request. */
  keyId: string;
  latencyMs: number;
  /** How many keys were tried before this one succeeded. */
  attempts: number;
}

/** Classification of a failed attempt, driving retry/cooldown policy. */
export type FailureKind =
  | 'rate-limited' // 429 — cool the key down, retry elsewhere immediately
  | 'server-error' // 500/502/503/504 — retry elsewhere
  | 'unauthorized' // 401/403 — disable the key, it will never recover on its own
  | 'timeout' // deadline exceeded
  | 'bad-request' // 400 — our fault, do not retry on another key
  | 'unknown';

export class NimError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly keyId?: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'NimError';
  }

  /** Whether trying a different key could plausibly succeed. */
  get isRetryable(): boolean {
    return (
      this.kind === 'rate-limited' ||
      this.kind === 'server-error' ||
      this.kind === 'timeout' ||
      this.kind === 'unknown'
    );
  }
}
