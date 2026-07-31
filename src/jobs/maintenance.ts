/**
 * Periodic maintenance.
 *
 * Three jobs on independent intervals: cache pruning (disk pressure), rate
 * limiter sweeping (memory pressure), and API usage snapshots (analytics).
 * All are best-effort — a failure logs and waits for the next tick rather than
 * escalating.
 */
import { createLogger } from '../utils/logger.js';
import { recordApiUsage } from '../database/repositories/ttsRepository.js';
import type { BotContext } from '../core/context.js';

const log = createLogger('jobs');

const CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly
const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // quarter-hourly
const USAGE_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // hourly

const timers: NodeJS.Timeout[] = [];

/**
 * Previous cumulative counters per key, so each snapshot records the delta for
 * its bucket rather than a running total.
 */
const previousCounts = new Map<
  string,
  { requests: number; successes: number; failures: number }
>();

export function startJobs(ctx: BotContext): void {
  timers.push(
    setInterval(() => {
      void ctx.cache.prune().catch((err) => log.warn({ err }, 'Cache prune failed'));
    }, CACHE_PRUNE_INTERVAL_MS),
  );

  timers.push(
    setInterval(() => {
      const removed = ctx.rateLimiter.sweep();
      if (removed > 0) log.debug({ removed }, 'Rate limiter swept');
    }, SWEEP_INTERVAL_MS),
  );

  timers.push(
    setInterval(() => {
      void snapshotApiUsage(ctx).catch((err) =>
        log.warn({ err }, 'API usage snapshot failed'),
      );
    }, USAGE_SNAPSHOT_INTERVAL_MS),
  );

  // Timers must not keep the process alive on their own.
  for (const t of timers) t.unref?.();

  log.info('Background jobs started');
}

async function snapshotApiUsage(ctx: BotContext): Promise<void> {
  const bucketStart = new Date();
  bucketStart.setMinutes(0, 0, 0);

  const rows = ctx.pool.stats().map((k) => {
    const prev = previousCounts.get(k.id) ?? { requests: 0, successes: 0, failures: 0 };
    previousCounts.set(k.id, {
      requests: k.requests,
      successes: k.successes,
      failures: k.failures,
    });

    return {
      keyId: k.id,
      requests: Math.max(0, k.requests - prev.requests),
      successes: Math.max(0, k.successes - prev.successes),
      failures: Math.max(0, k.failures - prev.failures),
      // The pool does not separate 429s from other failures in its snapshot,
      // so this is reported as zero rather than guessed at.
      rateLimited: 0,
      avgLatencyMs: k.avgLatencyMs,
    };
  });

  await recordApiUsage(bucketStart, rows.filter((r) => r.requests > 0));
}

export function stopJobs(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}
