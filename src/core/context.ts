/**
 * Application context — the composition root.
 *
 * Every long-lived dependency is constructed once here and passed explicitly to
 * the things that need it. Commands and events receive the context rather than
 * importing singletons, which keeps them unit-testable with fakes.
 */
import type { Client } from 'discord.js';

import type { AppConfig } from '../config/index.js';
import { AudioCache } from '../cache/index.js';
import { KeyPool } from '../nim/keyPool.js';
import { NimClient } from '../nim/client.js';
import { TtsService } from '../voice/ttsService.js';
import { SessionManager } from '../voice/session.js';
import { RateLimiter } from '../middleware/rateLimiter.js';

export interface BotContext {
  client: Client;
  config: AppConfig;
  pool: KeyPool;
  nim: NimClient;
  cache: AudioCache;
  tts: TtsService;
  sessions: SessionManager;
  rateLimiter: RateLimiter;
  startedAt: number;
}

export async function buildContext(client: Client, config: AppConfig): Promise<BotContext> {
  const pool = new KeyPool(config.nimKeys, {
    strategy: config.NIM_STRATEGY,
    cooldownMs: config.NIM_COOLDOWN_MS,
    circuitFailureThreshold: config.NIM_CIRCUIT_FAILURE_THRESHOLD,
    circuitResetMs: config.NIM_CIRCUIT_RESET_MS,
  });

  const nim = new NimClient(pool, {
    endpoint: config.NIM_GRPC_ENDPOINT,
    functionId: config.NIM_FUNCTION_ID,
    maxRetries: config.NIM_MAX_RETRIES,
    requestTimeoutMs: config.NIM_REQUEST_TIMEOUT_MS,
    sampleRateHz: config.NIM_SAMPLE_RATE_HZ,
  });

  const cache = new AudioCache({
    dir: config.CACHE_DIR,
    memoryMaxEntries: config.CACHE_MEMORY_MAX_ENTRIES,
    diskMaxBytes: config.CACHE_DISK_MAX_BYTES,
    ttlSeconds: config.CACHE_TTL_SECONDS,
  });
  await cache.init();

  const tts = new TtsService(nim, cache, config.NIM_SAMPLE_RATE_HZ);

  return {
    client,
    config,
    pool,
    nim,
    cache,
    tts,
    sessions: new SessionManager(),
    rateLimiter: new RateLimiter(),
    startedAt: Date.now(),
  };
}
