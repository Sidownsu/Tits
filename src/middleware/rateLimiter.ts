/**
 * Per-user rate limiting and duplicate suppression.
 *
 * Two distinct abuses to stop: someone spamming the channel to hog the queue,
 * and someone pasting the same line repeatedly. The cooldown handles the first;
 * a short-lived recent-message fingerprint handles the second.
 *
 * Deliberately in-memory. These windows are seconds long, so surviving a
 * restart is worth less than the round trip a shared store would cost.
 */
const DUPLICATE_WINDOW_MS = 10_000;

export interface RateLimitVerdict {
  allowed: boolean;
  reason?: 'cooldown' | 'duplicate';
  /** Milliseconds until the user may try again. */
  retryAfterMs?: number;
}

export class RateLimiter {
  private readonly lastUsed = new Map<string, number>();
  private readonly recentText = new Map<string, { hash: string; at: number }>();

  /** Cheap non-cryptographic hash; collisions here are harmless. */
  private static hash(text: string): string {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  check(userId: string, text: string, cooldownMs: number): RateLimitVerdict {
    const now = Date.now();

    const last = this.lastUsed.get(userId);
    if (last !== undefined && cooldownMs > 0 && now - last < cooldownMs) {
      return { allowed: false, reason: 'cooldown', retryAfterMs: cooldownMs - (now - last) };
    }

    const hash = RateLimiter.hash(text);
    const recent = this.recentText.get(userId);
    if (recent && recent.hash === hash && now - recent.at < DUPLICATE_WINDOW_MS) {
      return {
        allowed: false,
        reason: 'duplicate',
        retryAfterMs: DUPLICATE_WINDOW_MS - (now - recent.at),
      };
    }

    return { allowed: true };
  }

  /** Record an accepted message. Call only after the request is admitted. */
  commit(userId: string, text: string): void {
    const now = Date.now();
    this.lastUsed.set(userId, now);
    this.recentText.set(userId, { hash: RateLimiter.hash(text), at: now });
  }

  /** Drop entries older than an hour so the maps cannot grow unbounded. */
  sweep(): number {
    const cutoff = Date.now() - 3_600_000;
    let removed = 0;
    for (const [id, at] of this.lastUsed) {
      if (at < cutoff) {
        this.lastUsed.delete(id);
        removed += 1;
      }
    }
    for (const [id, entry] of this.recentText) {
      if (entry.at < cutoff) {
        this.recentText.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  reset(userId: string): void {
    this.lastUsed.delete(userId);
    this.recentText.delete(userId);
  }
}
