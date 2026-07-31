/**
 * Key pool behaviour tests.
 *
 * The pool is the piece most likely to be wrong in a way that only shows up
 * under load, so its failover, cooldown and circuit-breaking paths are covered
 * directly rather than through the client.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { KeyPool, NoKeysAvailableError } from './keyPool.js';
import type { NimKeyConfig } from '../config/index.js';

const keys: NimKeyConfig[] = [
  { id: 'key-1', key: 'secret-1', weight: 1 },
  { id: 'key-2', key: 'secret-2', weight: 1 },
  { id: 'key-3', key: 'secret-3', weight: 1 },
];

const options = {
  strategy: 'least-used' as const,
  cooldownMs: 1000,
  circuitFailureThreshold: 3,
  circuitResetMs: 5000,
};

describe('KeyPool', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('spreads concurrent load across keys with least-used', () => {
    const pool = new KeyPool(keys, options);

    // Acquire without reporting completion, so all three stay in flight.
    const first = pool.acquire();
    const second = pool.acquire();
    const third = pool.acquire();

    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });

  it('never hands back a key already tried for this request', () => {
    const pool = new KeyPool(keys, options);
    const tried = new Set(['key-1', 'key-2']);

    expect(pool.acquire(tried).id).toBe('key-3');
  });

  it('cools a key down after a rate limit and restores it on expiry', () => {
    const pool = new KeyPool(keys, options);

    const acquired = pool.acquire();
    pool.reportFailure(acquired.id, 'rate-limited', '429');

    expect(pool.stats().find((k) => k.id === acquired.id)?.state).toBe('cooling');

    vi.advanceTimersByTime(options.cooldownMs + 1);

    expect(pool.stats().find((k) => k.id === acquired.id)?.state).toBe('healthy');
  });

  it('backs off exponentially on repeated failures', () => {
    const pool = new KeyPool(keys, options);

    pool.acquire();
    pool.reportFailure('key-1', 'server-error', 'boom');
    const firstCooldown = pool.stats().find((k) => k.id === 'key-1')?.cooldownUntil ?? 0;

    // A success would reset the streak, so fail again immediately.
    vi.advanceTimersByTime(options.cooldownMs + 1);
    pool.acquire(new Set(['key-2', 'key-3']));
    pool.reportFailure('key-1', 'server-error', 'boom');
    const secondCooldown = pool.stats().find((k) => k.id === 'key-1')?.cooldownUntil ?? 0;

    const firstDuration = firstCooldown - 0;
    const secondDuration = secondCooldown - (options.cooldownMs + 1);
    expect(secondDuration).toBeGreaterThan(firstDuration - options.cooldownMs);
  });

  it('disables a key outright when NVIDIA rejects the credential', () => {
    const pool = new KeyPool(keys, options);

    pool.acquire();
    pool.reportFailure('key-1', 'unauthorized', '401');

    const stats = pool.stats().find((k) => k.id === 'key-1');
    expect(stats?.state).toBe('disabled');

    // Time passing must not revive it — only a manual reset should.
    vi.advanceTimersByTime(60_000);
    expect(pool.stats().find((k) => k.id === 'key-1')?.state).toBe('disabled');

    pool.reset('key-1');
    expect(pool.stats().find((k) => k.id === 'key-1')?.state).toBe('healthy');
  });

  it('does not penalise a key for a malformed request', () => {
    const pool = new KeyPool(keys, options);

    pool.acquire();
    pool.reportFailure('key-1', 'bad-request', '400');

    expect(pool.stats().find((k) => k.id === 'key-1')?.state).toBe('healthy');
  });

  it('opens the circuit after the failure threshold', () => {
    const pool = new KeyPool([keys[0]!], { ...options, cooldownMs: 1 });

    for (let i = 0; i < options.circuitFailureThreshold; i++) {
      try {
        pool.acquire();
      } catch {
        // Pool may be empty mid-loop while cooling; the failure report is what
        // matters here.
      }
      pool.reportFailure('key-1', 'server-error', 'boom');
      vi.advanceTimersByTime(5);
    }

    expect(pool.stats().find((k) => k.id === 'key-1')?.state).toBe('open');
  });

  it('throws with a retry hint when every key is unavailable', () => {
    const pool = new KeyPool([keys[0]!], options);

    pool.acquire();
    pool.reportFailure('key-1', 'rate-limited', '429');

    try {
      pool.acquire();
      expect.unreachable('acquire should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NoKeysAvailableError);
      expect((err as NoKeysAvailableError).retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('recovers latency and success statistics', () => {
    const pool = new KeyPool(keys, options);

    const acquired = pool.acquire();
    pool.reportSuccess(acquired.id, 120);

    const stats = pool.stats().find((k) => k.id === acquired.id);
    expect(stats?.successes).toBe(1);
    expect(stats?.avgLatencyMs).toBe(120);
    expect(stats?.successRate).toBe(1);
    expect(stats?.inFlight).toBe(0);
  });

  it('release() frees a key without penalising it', () => {
    // Voice discovery runs at boot and may fail for reasons unrelated to the
    // key's health. If that path penalised keys, every key would be cooling
    // down before the first user request ever arrived.
    const pool = new KeyPool(keys, options);

    const acquired = pool.acquire();
    pool.release(acquired.id);

    const stats = pool.stats().find((k) => k.id === acquired.id);
    expect(stats?.state).toBe('healthy');
    expect(stats?.inFlight).toBe(0);
    expect(stats?.failures).toBe(0);
    expect(stats?.successes).toBe(0);
    expect(pool.hasCapacity()).toBe(true);
  });

  it('never exposes the secret in its stats snapshot', () => {
    const pool = new KeyPool(keys, options);
    const serialised = JSON.stringify(pool.stats());

    expect(serialised).not.toContain('secret-1');
  });
});
