/**
 * User preferences repository.
 *
 * Reads are cached in memory because the TTS hot path hits this on every single
 * message; a round trip to Supabase per message would dominate latency. Writes
 * go through the repository so the cache is always updated in lockstep.
 */
import { db } from '../client.js';
import { createLogger } from '../../utils/logger.js';
import { DEFAULT_EMOTION, DEFAULT_LOCALE, DEFAULT_SPEAKER } from '../../nim/voices.js';
import type { EffectivePreferences, UserRow } from '../types.js';

const log = createLogger('db:users');
const TABLE = 'users';

/** How long a cached user row stays valid. */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  row: UserRow;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export const USER_DEFAULTS = {
  locale: DEFAULT_LOCALE,
  speaker: DEFAULT_SPEAKER,
  emotion: DEFAULT_EMOTION,
  speed: 1.0,
  pitch_semitones: 0,
  volume: 1.0,
  read_urls: false,
  read_emoji: true,
  nsfw_filter: true,
  auto_join: false,
  spoken_name: null,
} as const;

function buildDefaultRow(userId: string, username?: string): UserRow {
  const now = new Date().toISOString();
  return {
    id: userId,
    username: username ?? null,
    created_at: now,
    updated_at: now,
    ...USER_DEFAULTS,
  };
}

/**
 * Fetch a user, creating a defaults row on first sight.
 *
 * Never throws for database trouble — a transient Supabase outage degrades to
 * in-memory defaults rather than silencing the bot.
 */
export async function getUser(userId: string, username?: string): Promise<UserRow> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.row;

  try {
    const { data, error } = await db()
      .from(TABLE)
      .select('*')
      .eq('id', userId)
      .maybeSingle<UserRow>();

    if (error) throw new Error(error.message);

    if (data) {
      cache.set(userId, { row: data, expiresAt: Date.now() + CACHE_TTL_MS });
      return data;
    }

    // First time we have seen this user — persist defaults.
    const row = buildDefaultRow(userId, username);
    const { error: insertError } = await db().from(TABLE).insert(row);
    if (insertError && !insertError.message.includes('duplicate')) {
      throw new Error(insertError.message);
    }

    cache.set(userId, { row, expiresAt: Date.now() + CACHE_TTL_MS });
    return row;
  } catch (err) {
    log.error({ err, userId }, 'getUser failed; falling back to defaults');
    return buildDefaultRow(userId, username);
  }
}

/** Merge a partial update into the user's row and refresh the cache. */
export async function updateUser(
  userId: string,
  changes: Partial<Omit<UserRow, 'id' | 'created_at' | 'updated_at'>>,
): Promise<UserRow> {
  const current = await getUser(userId);
  const merged: UserRow = { ...current, ...changes, updated_at: new Date().toISOString() };

  try {
    const { error } = await db()
      .from(TABLE)
      .upsert(merged, { onConflict: 'id' });
    if (error) throw new Error(error.message);
  } catch (err) {
    log.error({ err, userId }, 'updateUser failed');
    throw err;
  }

  cache.set(userId, { row: merged, expiresAt: Date.now() + CACHE_TTL_MS });
  return merged;
}

/** Restore a user to stock defaults. */
export async function resetUser(userId: string): Promise<UserRow> {
  return updateUser(userId, { ...USER_DEFAULTS });
}

/**
 * Resolve the preferences the pipeline should actually use, letting guild
 * defaults fill in for a user who has never customised anything.
 */
export function toEffectivePreferences(
  user: UserRow,
  guildDefaults?: { locale: string; speaker: string; emotion: string },
): EffectivePreferences {
  const untouched =
    user.locale === USER_DEFAULTS.locale &&
    user.speaker === USER_DEFAULTS.speaker &&
    user.emotion === USER_DEFAULTS.emotion;

  return {
    locale: untouched && guildDefaults ? guildDefaults.locale : user.locale,
    speaker: untouched && guildDefaults ? guildDefaults.speaker : user.speaker,
    emotion: untouched && guildDefaults ? guildDefaults.emotion : user.emotion,
    speed: Number(user.speed),
    pitchSemitones: user.pitch_semitones,
    volume: Number(user.volume),
    readUrls: user.read_urls,
    readEmoji: user.read_emoji,
    spokenName: user.spoken_name,
  };
}

export function invalidateUserCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}
