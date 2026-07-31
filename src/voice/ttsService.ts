/**
 * The synthesis pipeline.
 *
 * sanitize → chunk → (cache lookup | NIM synthesis) → cache store → concat
 *
 * Chunking exists because Magpie caps output at roughly 20 seconds per request;
 * long messages are split on sentence boundaries and the resulting PCM is
 * concatenated. Because each chunk is cached independently, a message that
 * shares a sentence with an earlier one gets a partial cache hit.
 */
import { createLogger, nextRequestId } from '../utils/logger.js';
import { chunkForSynthesis, sanitize, type MentionResolvers } from '../utils/text.js';
import type { AudioCache} from '../cache/index.js';
import { cacheKey } from '../cache/index.js';
import type { NimClient } from '../nim/client.js';
import { resolveVoice } from '../nim/voices.js';
import { NimError } from '../nim/types.js';
import { logUsage, recordHistory } from '../database/repositories/ttsRepository.js';
import type { EffectivePreferences } from '../database/types.js';

const log = createLogger('tts');

export interface SynthesizeOptions {
  text: string;
  preferences: EffectivePreferences;
  userId: string;
  guildId: string | null;
  pronunciations?: Map<string, string>;
  resolvers?: MentionResolvers;
  maxChars: number;
  /** Skip cache lookup (used by previews of a voice the user is auditioning). */
  bypassCache?: boolean;
}

export interface SynthesizeOutcome {
  pcm: Buffer;
  sampleRateHz: number;
  voiceName: string;
  spokenText: string;
  chunkCount: number;
  cacheHits: number;
  latencyMs: number;
  /** Distinct pool keys that served this request. */
  keysUsed: string[];
}

export class EmptyTextError extends Error {
  constructor() {
    super('Nothing left to speak after sanitisation.');
    this.name = 'EmptyTextError';
  }
}

export class TtsService {
  constructor(
    private readonly nim: NimClient,
    private readonly cache: AudioCache,
    private readonly sampleRateHz: number,
  ) {}

  async synthesize(options: SynthesizeOptions): Promise<SynthesizeOutcome> {
    const requestId = nextRequestId();
    const started = Date.now();

    const spokenText = sanitize(options.text, {
      readUrls: options.preferences.readUrls,
      readEmoji: options.preferences.readEmoji,
      pronunciations: options.pronunciations,
      resolvers: options.resolvers,
      maxLength: options.maxChars,
    });

    if (!spokenText) throw new EmptyTextError();

    const voice = resolveVoice(
      options.preferences.locale,
      options.preferences.speaker,
      options.preferences.emotion,
    );

    const chunks = chunkForSynthesis(spokenText);
    const parts: Buffer[] = [];
    const keysUsed = new Set<string>();
    let cacheHits = 0;

    try {
      for (const chunk of chunks) {
        const key = cacheKey({
          text: chunk,
          voiceName: voice.name,
          languageCode: voice.locale,
          sampleRateHz: this.sampleRateHz,
        });

        if (!options.bypassCache) {
          const hit = await this.cache.get(key);
          if (hit) {
            parts.push(hit);
            cacheHits += 1;
            continue;
          }
        }

        const result = await this.nim.synthesize({
          text: chunk,
          voiceName: voice.name,
          languageCode: voice.locale,
          sampleRateHz: this.sampleRateHz,
          requestId,
        });

        keysUsed.add(result.keyId);
        parts.push(result.audio);
        void this.cache.set(key, result.audio);
      }
    } catch (err) {
      const latencyMs = Date.now() - started;
      logUsage({
        user_id: options.userId,
        guild_id: options.guildId,
        voice_name: voice.name,
        char_count: spokenText.length,
        chunk_count: chunks.length,
        cache_hit: false,
        latency_ms: latencyMs,
        success: false,
        error_kind: err instanceof NimError ? err.kind : 'unknown',
      });
      log.error({ err, requestId, userId: options.userId }, 'Synthesis failed');
      throw err;
    }

    const latencyMs = Date.now() - started;
    const pcm = Buffer.concat(parts);

    logUsage({
      user_id: options.userId,
      guild_id: options.guildId,
      voice_name: voice.name,
      char_count: spokenText.length,
      chunk_count: chunks.length,
      cache_hit: cacheHits === chunks.length,
      latency_ms: latencyMs,
      success: true,
      error_kind: null,
    });

    void recordHistory({
      userId: options.userId,
      guildId: options.guildId,
      text: spokenText,
      voiceName: voice.name,
      cached: cacheHits === chunks.length,
    });

    log.debug(
      { requestId, chunks: chunks.length, cacheHits, latencyMs },
      'Synthesis complete',
    );

    return {
      pcm,
      sampleRateHz: this.sampleRateHz,
      voiceName: voice.name,
      spokenText,
      chunkCount: chunks.length,
      cacheHits,
      latencyMs,
      keysUsed: [...keysUsed],
    };
  }
}
