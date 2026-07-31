/**
 * NVIDIA NIM (Riva / Magpie) TTS client.
 *
 * Talks to NVCF over gRPC. NVIDIA ships official Riva clients for Python and
 * C++ only, so this drives the service directly with @grpc/grpc-js against the
 * Riva protos.
 *
 * Retry model
 * ───────────
 * A logical synthesis request may consume several keys. `synthesize()` asks the
 * pool for a key, attempts the call, and on a retryable failure asks for a
 * *different* key and tries again — up to `maxRetries`. The pool applies the
 * cooldown/circuit penalties; this class decides only whether to try again.
 *
 * Auth is per-call metadata rather than per-channel, which is what lets a single
 * shared channel serve every key in the pool.
 */
import { credentials, Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import type { ServiceError } from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import * as grpc from '@grpc/grpc-js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '../utils/logger.js';
import type { KeyPool} from './keyPool.js';
import { NoKeysAvailableError } from './keyPool.js';
import { NimError } from './types.js';
import type { FailureKind, SynthesisRequest, SynthesisResult } from './types.js';
import { reconcileCatalogue } from './voices.js';

const log = createLogger('nim:client');
const here = dirname(fileURLToPath(import.meta.url));

/** LINEAR_PCM — matches the AudioEncoding enum in the proto. */
const ENCODING_LINEAR_PCM = 1;

/**
 * Locate the proto to load. Vendored upstream protos win when present; the
 * trimmed bundled copy is the fallback so a fresh clone works with no extra
 * setup step.
 */
function resolveProtoPath(): { file: string; includeDirs: string[] } {
  const vendored = join(
    here,
    'protos',
    'vendor',
    'common',
    'riva',
    'proto',
    'riva_tts.proto',
  );
  if (existsSync(vendored)) {
    return {
      file: vendored,
      includeDirs: [join(here, 'protos', 'vendor', 'common')],
    };
  }
  return {
    file: join(here, 'protos', 'riva_tts.proto'),
    includeDirs: [join(here, 'protos')],
  };
}

/**
 * Follow a dotted path through the loaded proto package without asserting its
 * shape. Returns `undefined` rather than throwing if any segment is missing.
 */
function lookup(root: unknown, path: string[]): unknown {
  let node: unknown = root;
  for (const segment of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Map a gRPC status code onto our retry taxonomy. */
function classify(err: ServiceError): { kind: FailureKind; statusCode: number } {
  switch (err.code) {
    case GrpcStatus.RESOURCE_EXHAUSTED:
      return { kind: 'rate-limited', statusCode: 429 };
    case GrpcStatus.UNAUTHENTICATED:
    case GrpcStatus.PERMISSION_DENIED:
      return { kind: 'unauthorized', statusCode: 401 };
    case GrpcStatus.DEADLINE_EXCEEDED:
      return { kind: 'timeout', statusCode: 504 };
    case GrpcStatus.UNAVAILABLE:
    case GrpcStatus.INTERNAL:
    case GrpcStatus.ABORTED:
      return { kind: 'server-error', statusCode: 503 };
    case GrpcStatus.INVALID_ARGUMENT:
    case GrpcStatus.NOT_FOUND:
      return { kind: 'bad-request', statusCode: 400 };
    default:
      return { kind: 'unknown', statusCode: 500 };
  }
}

/** NVCF signals rate limiting in trailers on some paths; catch that too. */
function looksRateLimited(err: ServiceError): boolean {
  const detail = `${err.details ?? ''} ${err.message ?? ''}`.toLowerCase();
  return detail.includes('429') || detail.includes('rate limit') || detail.includes('too many requests');
}

export interface NimClientOptions {
  endpoint: string;
  functionId: string;
  maxRetries: number;
  requestTimeoutMs: number;
  sampleRateHz: number;
}

interface SynthesisClient {
  Synthesize(
    req: unknown,
    metadata: Metadata,
    options: { deadline: Date },
    cb: (err: ServiceError | null, res?: { audio?: Buffer }) => void,
  ): void;
  GetRivaSynthesisConfig(
    req: unknown,
    metadata: Metadata,
    options: { deadline: Date },
    cb: (err: ServiceError | null, res?: RivaConfigResponse) => void,
  ): void;
}

/** The generated client class proto-loader produces for a service definition. */
type GrpcServiceConstructor = new (
  address: string,
  creds: ReturnType<typeof credentials.createSsl>,
) => SynthesisClient;

interface RivaConfigResponse {
  model_config?: Array<{
    model_name?: string;
    parameters?: Record<string, string>;
  }>;
}

export class NimClient {
  private readonly client: SynthesisClient;
  private readonly options: NimClientOptions;

  constructor(
    private readonly pool: KeyPool,
    options: NimClientOptions,
  ) {
    this.options = options;

    const { file, includeDirs } = resolveProtoPath();
    const definition = protoLoader.loadSync(file, {
      keepCase: true,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
      includeDirs,
    });

    const pkg = grpc.loadPackageDefinition(definition);

    // Walk the package tree defensively: the bundled proto and the vendored
    // upstream one have both nested the service under `nvidia.riva.tts` and,
    // in older revisions, directly under `nvidia.riva`.
    const ServiceCtor =
      lookup(pkg, ['nvidia', 'riva', 'tts', 'RivaSpeechSynthesis']) ??
      lookup(pkg, ['nvidia', 'riva', 'RivaSpeechSynthesis']);

    if (typeof ServiceCtor !== 'function') {
      throw new Error(
        'Could not locate RivaSpeechSynthesis in the loaded proto package.',
      );
    }

    // TLS is mandatory for NVCF. A single channel is shared across all keys
    // because credentials travel per-call in metadata, not on the channel.
    const Ctor = ServiceCtor as GrpcServiceConstructor;
    this.client = new Ctor(options.endpoint, credentials.createSsl());

    log.info({ endpoint: options.endpoint }, 'NIM gRPC client ready');
  }

  private metadataFor(apiKey: string): Metadata {
    const md = new Metadata();
    md.set('authorization', `Bearer ${apiKey}`);
    md.set('function-id', this.options.functionId);
    return md;
  }

  private deadline(): Date {
    return new Date(Date.now() + this.options.requestTimeoutMs);
  }

  /**
   * Synthesize `text` to raw PCM, failing over across keys as needed.
   *
   * @throws {NimError} when every attempt fails or the request is invalid.
   * @throws {NoKeysAvailableError} when no key is eligible at all.
   */
  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const tried = new Set<string>();
    const sampleRateHz = req.sampleRateHz ?? this.options.sampleRateHz;
    let lastError: NimError | null = null;

    const maxAttempts = Math.min(this.options.maxRetries + 1, this.pool.size + 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let acquired: { id: string; key: string };
      try {
        acquired = this.pool.acquire(tried);
      } catch (err) {
        if (err instanceof NoKeysAvailableError) {
          // Nothing eligible. Surface the earlier failure if we have one, since
          // it explains *why* the pool is empty.
          throw lastError ?? err;
        }
        throw err;
      }

      tried.add(acquired.id);
      const started = Date.now();

      try {
        const audio = await this.callSynthesize(acquired.key, req, sampleRateHz);
        const latencyMs = Date.now() - started;
        this.pool.reportSuccess(acquired.id, latencyMs);

        log.debug(
          { requestId: req.requestId, keyId: acquired.id, latencyMs, attempt },
          'Synthesis succeeded',
        );

        return { audio, sampleRateHz, keyId: acquired.id, latencyMs, attempts: attempt };
      } catch (err) {
        const nimErr = err as NimError;
        this.pool.reportFailure(acquired.id, nimErr.kind, nimErr.message);
        lastError = nimErr;

        log.warn(
          {
            requestId: req.requestId,
            keyId: acquired.id,
            kind: nimErr.kind,
            attempt,
            maxAttempts,
          },
          'Synthesis attempt failed',
        );

        // A malformed request will fail identically on every key.
        if (!nimErr.isRetryable) throw nimErr;
      }
    }

    throw (
      lastError ??
      new NimError('Synthesis failed with no recorded error', 'unknown')
    );
  }

  /** One gRPC attempt against one key. */
  private callSynthesize(
    apiKey: string,
    req: SynthesisRequest,
    sampleRateHz: number,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const payload = {
        text: req.text,
        language_code: req.languageCode,
        encoding: ENCODING_LINEAR_PCM,
        sample_rate_hz: sampleRateHz,
        voice_name: req.voiceName,
        ...(req.requestId ? { id: { value: req.requestId } } : {}),
      };

      this.client.Synthesize(
        payload,
        this.metadataFor(apiKey),
        { deadline: this.deadline() },
        (err, res) => {
          if (err) {
            const { kind, statusCode } = classify(err);
            const finalKind: FailureKind =
              kind === 'unknown' && looksRateLimited(err) ? 'rate-limited' : kind;
            reject(
              new NimError(
                err.details || err.message || 'gRPC call failed',
                finalKind,
                undefined,
                statusCode,
              ),
            );
            return;
          }

          const audio = res?.audio;
          if (!audio || audio.length === 0) {
            reject(new NimError('NIM returned empty audio', 'server-error'));
            return;
          }

          resolve(Buffer.from(audio));
        },
      );
    });
  }

  /**
   * Ask the service which voices actually exist and update the catalogue.
   *
   * Best-effort: a failure here is logged and swallowed, leaving the seed
   * catalogue in place. The bot should still boot if discovery is unavailable.
   */
  async discoverVoices(): Promise<void> {
    let acquired: { id: string; key: string };
    try {
      acquired = this.pool.acquire();
    } catch {
      log.warn('No key available for voice discovery; keeping seed catalogue');
      return;
    }

    try {
      const res = await new Promise<RivaConfigResponse>((resolve, reject) => {
        this.client.GetRivaSynthesisConfig(
          {},
          this.metadataFor(acquired.key),
          { deadline: this.deadline() },
          (err, r) => (err ? reject(err) : resolve(r ?? {})),
        );
      });

      // Discovery is not synthesis: release rather than crediting a success,
      // so latency statistics stay representative of real TTS calls.
      this.pool.release(acquired.id);

      // Riva reports voices in a `voice_name` parameter, comma or space
      // separated depending on version. Normalise both.
      const names = new Set<string>();
      for (const cfg of res.model_config ?? []) {
        const raw = cfg.parameters?.voice_name ?? cfg.parameters?.voices ?? '';
        for (const piece of raw.split(/[,\s]+/)) {
          const trimmed = piece.trim();
          if (trimmed) names.add(trimmed);
        }
      }

      if (names.size > 0) {
        reconcileCatalogue([...names]);
      } else {
        log.warn('Service reported no voice names; keeping seed catalogue');
      }
    } catch (err) {
      // Deliberately not a pool failure. GetRivaSynthesisConfig may not be
      // routable through an NVCF function-id at all, and cooling every key at
      // boot over an auxiliary RPC would leave the first real request with an
      // empty pool. An auth problem here still surfaces on the first synthesis.
      this.pool.release(acquired.id);
      log.warn(
        { err },
        'Voice discovery unavailable; keeping seed catalogue (keys unaffected)',
      );
    }
  }
}
