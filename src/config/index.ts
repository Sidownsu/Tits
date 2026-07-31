/**
 * Environment loading and validation.
 *
 * Everything the bot needs from the outside world funnels through here and is
 * validated once at boot. If the process gets past `loadConfig()`, the rest of
 * the codebase can treat configuration as known-good and fully typed.
 */
import { z } from 'zod';

/** Coerce a possibly-empty env string into `undefined` so zod defaults apply. */
const optionalString = z
  .string()
  .transform((v) => (v.trim() === '' ? undefined : v.trim()))
  .optional();

const intFromEnv = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const envSchema = z.object({
  // Discord
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DEBUG_GUILD_ID: optionalString,

  // NIM keys — only the first is mandatory.
  NIM_KEY_1: z.string().min(1, 'At least NIM_KEY_1 must be set'),
  NIM_KEY_2: optionalString,
  NIM_KEY_3: optionalString,
  NIM_KEY_4: optionalString,
  NIM_KEY_5: optionalString,
  NIM_KEY_WEIGHTS: optionalString,

  NIM_GRPC_ENDPOINT: z.string().default('grpc.nvcf.nvidia.com:443'),
  NIM_FUNCTION_ID: z.string().min(1, 'NIM_FUNCTION_ID is required'),
  NIM_STRATEGY: z
    .enum(['round-robin', 'least-used', 'weighted', 'lowest-latency'])
    .default('least-used'),

  NIM_MAX_RETRIES: intFromEnv(3),
  NIM_REQUEST_TIMEOUT_MS: intFromEnv(15_000),
  NIM_COOLDOWN_MS: intFromEnv(60_000),
  NIM_CIRCUIT_FAILURE_THRESHOLD: intFromEnv(5),
  NIM_CIRCUIT_RESET_MS: intFromEnv(120_000),

  // Supabase
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_KEY: z.string().min(1, 'SUPABASE_KEY is required'),

  // Audio
  NIM_SAMPLE_RATE_HZ: intFromEnv(22_050),
  AUDIO_BITRATE: intFromEnv(64_000),

  // Cache
  CACHE_DIR: z.string().default('./.cache/audio'),
  CACHE_MEMORY_MAX_ENTRIES: intFromEnv(500),
  CACHE_DISK_MAX_BYTES: intFromEnv(536_870_912),
  CACHE_TTL_SECONDS: intFromEnv(604_800),

  // Limits
  MAX_MESSAGE_CHARS: intFromEnv(500),
  MAX_MESSAGE_CHARS_PREMIUM: intFromEnv(2000),
  USER_COOLDOWN_MS: intFromEnv(2000),
  MAX_QUEUE_SIZE: intFromEnv(50),

  // Runtime
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface NimKeyConfig {
  /** Stable identifier used in logs and stats. Never contains the secret. */
  id: string;
  key: string;
  weight: number;
}

export interface AppConfig extends RawEnv {
  /** Every configured NIM key, normalised into a pool entry. */
  nimKeys: NimKeyConfig[];
  isProduction: boolean;
}

let cached: AppConfig | null = null;

/**
 * Parse `process.env` into a validated config object.
 *
 * Throws with a readable, aggregated message when anything is missing so a
 * misconfigured deploy fails loudly at boot rather than at first request.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const data = parsed.data;

  const rawKeys = [
    data.NIM_KEY_1,
    data.NIM_KEY_2,
    data.NIM_KEY_3,
    data.NIM_KEY_4,
    data.NIM_KEY_5,
  ];

  const weights = (data.NIM_KEY_WEIGHTS ?? '')
    .split(',')
    .map((w) => Number(w.trim()))
    .map((w) => (Number.isFinite(w) && w > 0 ? w : 1));

  const nimKeys: NimKeyConfig[] = rawKeys
    .map((key, index) => ({ key, index }))
    .filter((entry): entry is { key: string; index: number } => Boolean(entry.key))
    .map(({ key, index }) => ({
      id: `key-${index + 1}`,
      key,
      weight: weights[index] ?? 1,
    }));

  if (nimKeys.length === 0) {
    throw new Error('No NIM API keys configured — set at least NIM_KEY_1.');
  }

  cached = {
    ...data,
    nimKeys,
    isProduction: data.NODE_ENV === 'production',
  };
  return cached;
}

/** Test seam: forget the memoised config so a fresh env can be parsed. */
export function resetConfigForTests(): void {
  cached = null;
}
