/**
 * Repositories for the smaller TTS-adjacent tables: history, favourites,
 * pronunciations, usage telemetry, premium and blacklist.
 *
 * Telemetry writes are fire-and-forget by design — logging must never add
 * latency to, or be able to fail, a synthesis request.
 */
import { db } from '../client.js';
import { createLogger } from '../../utils/logger.js';
import type {
  BlacklistRow,
  FavoriteRow,
  PremiumRow,
  PronunciationRow,
  UsageLogInsert,
  VoiceHistoryRow,
} from '../types.js';

const log = createLogger('db:tts');

// ─── History ──────────────────────────────────────────────────────────────────

export async function recordHistory(entry: {
  userId: string;
  guildId: string | null;
  text: string;
  voiceName: string;
  cached: boolean;
}): Promise<void> {
  const { error } = await db().from('voice_history').insert({
    user_id: entry.userId,
    guild_id: entry.guildId,
    text: entry.text.slice(0, 2000),
    voice_name: entry.voiceName,
    cached: entry.cached,
  });
  if (error) log.warn({ err: error.message }, 'recordHistory failed');
}

export async function getHistory(userId: string, limit = 20): Promise<VoiceHistoryRow[]> {
  const { data, error } = await db()
    .from('voice_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    log.warn({ err: error.message }, 'getHistory failed');
    return [];
  }
  return (data ?? []) as VoiceHistoryRow[];
}

export async function clearHistory(userId: string): Promise<void> {
  const { error } = await db().from('voice_history').delete().eq('user_id', userId);
  if (error) throw new Error(error.message);
}

// ─── Favourites ───────────────────────────────────────────────────────────────

export async function addFavorite(userId: string, voiceName: string): Promise<void> {
  const { error } = await db()
    .from('favorites')
    .upsert({ user_id: userId, voice_name: voiceName }, { onConflict: 'user_id,voice_name' });
  if (error) throw new Error(error.message);
}

export async function removeFavorite(userId: string, voiceName: string): Promise<void> {
  const { error } = await db()
    .from('favorites')
    .delete()
    .match({ user_id: userId, voice_name: voiceName });
  if (error) throw new Error(error.message);
}

export async function getFavorites(userId: string): Promise<FavoriteRow[]> {
  const { data, error } = await db()
    .from('favorites')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    log.warn({ err: error.message }, 'getFavorites failed');
    return [];
  }
  return (data ?? []) as FavoriteRow[];
}

// ─── Pronunciations ───────────────────────────────────────────────────────────

const pronunciationCache = new Map<string, { map: Map<string, string>; expiresAt: number }>();
const PRONUNCIATION_TTL_MS = 5 * 60 * 1000;

/**
 * Build the effective pronunciation dictionary for a user in a guild.
 * Guild-wide entries load first so a user's personal override wins on conflict.
 */
export async function getPronunciationMap(
  userId: string,
  guildId: string | null,
): Promise<Map<string, string>> {
  const cacheKey = `${guildId ?? 'dm'}:${userId}`;
  const cached = pronunciationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.map;

  const map = new Map<string, string>();
  try {
    const scopes: Array<{ scope_type: string; scope_id: string }> = [];
    if (guildId) scopes.push({ scope_type: 'guild', scope_id: guildId });
    scopes.push({ scope_type: 'user', scope_id: userId });

    for (const scope of scopes) {
      const { data, error } = await db()
        .from('pronunciations')
        .select('*')
        .match(scope);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as PronunciationRow[]) {
        map.set(row.from_text, row.to_text);
      }
    }
  } catch (err) {
    log.warn({ err }, 'getPronunciationMap failed; using empty dictionary');
  }

  pronunciationCache.set(cacheKey, { map, expiresAt: Date.now() + PRONUNCIATION_TTL_MS });
  return map;
}

export async function setPronunciation(
  scopeType: 'user' | 'guild',
  scopeId: string,
  from: string,
  to: string,
): Promise<void> {
  const { error } = await db()
    .from('pronunciations')
    .upsert(
      { scope_type: scopeType, scope_id: scopeId, from_text: from, to_text: to },
      { onConflict: 'scope_type,scope_id,from_text' },
    );
  if (error) throw new Error(error.message);
  pronunciationCache.clear();
}

export async function deletePronunciation(
  scopeType: 'user' | 'guild',
  scopeId: string,
  from: string,
): Promise<void> {
  const { error } = await db()
    .from('pronunciations')
    .delete()
    .match({ scope_type: scopeType, scope_id: scopeId, from_text: from });
  if (error) throw new Error(error.message);
  pronunciationCache.clear();
}

export async function listPronunciations(
  scopeType: 'user' | 'guild',
  scopeId: string,
): Promise<PronunciationRow[]> {
  const { data, error } = await db()
    .from('pronunciations')
    .select('*')
    .match({ scope_type: scopeType, scope_id: scopeId })
    .order('from_text');

  if (error) {
    log.warn({ err: error.message }, 'listPronunciations failed');
    return [];
  }
  return (data ?? []) as PronunciationRow[];
}

// ─── Usage telemetry ──────────────────────────────────────────────────────────

/** Fire-and-forget: never awaited on the synthesis path. */
export function logUsage(entry: UsageLogInsert): void {
  void db()
    .from('usage_logs')
    .insert(entry)
    .then(({ error }) => {
      if (error) log.warn({ err: error.message }, 'logUsage failed');
    });
}

/** Persist an hourly snapshot of per-key statistics. */
export async function recordApiUsage(
  bucketStart: Date,
  stats: Array<{
    keyId: string;
    requests: number;
    successes: number;
    failures: number;
    rateLimited: number;
    avgLatencyMs: number;
  }>,
): Promise<void> {
  if (stats.length === 0) return;
  const rows = stats.map((s) => ({
    key_id: s.keyId,
    bucket_start: bucketStart.toISOString(),
    requests: s.requests,
    successes: s.successes,
    failures: s.failures,
    rate_limited: s.rateLimited,
    avg_latency_ms: s.avgLatencyMs,
  }));

  const { error } = await db()
    .from('api_usage')
    .upsert(rows, { onConflict: 'key_id,bucket_start' });
  if (error) log.warn({ err: error.message }, 'recordApiUsage failed');
}

// ─── Premium ──────────────────────────────────────────────────────────────────

const premiumCache = new Map<string, { row: PremiumRow | null; expiresAt: number }>();

export async function getPremium(
  subjectType: 'user' | 'guild',
  subjectId: string,
): Promise<PremiumRow | null> {
  const key = `${subjectType}:${subjectId}`;
  const cached = premiumCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.row;

  const { data, error } = await db()
    .from('premium')
    .select('*')
    .match({ subject_type: subjectType, subject_id: subjectId })
    .maybeSingle<PremiumRow>();

  if (error) {
    log.warn({ err: error.message }, 'getPremium failed');
    return null;
  }

  // An expired grant is treated as absent.
  const row =
    data && data.expires_at && new Date(data.expires_at) < new Date() ? null : data;

  premiumCache.set(key, { row, expiresAt: Date.now() + 60_000 });
  return row;
}

/** True when either the user personally or their guild carries premium. */
export async function isPremium(userId: string, guildId: string | null): Promise<boolean> {
  const [user, guild] = await Promise.all([
    getPremium('user', userId),
    guildId ? getPremium('guild', guildId) : Promise.resolve(null),
  ]);
  return Boolean(user || guild);
}

export async function grantPremium(
  subjectType: 'user' | 'guild',
  subjectId: string,
  tier: 'plus' | 'pro',
  expiresAt: Date | null,
  note?: string,
): Promise<void> {
  const { error } = await db()
    .from('premium')
    .upsert(
      {
        subject_type: subjectType,
        subject_id: subjectId,
        tier,
        expires_at: expiresAt?.toISOString() ?? null,
        note: note ?? null,
      },
      { onConflict: 'subject_type,subject_id' },
    );
  if (error) throw new Error(error.message);
  premiumCache.clear();
}

export async function revokePremium(
  subjectType: 'user' | 'guild',
  subjectId: string,
): Promise<void> {
  const { error } = await db()
    .from('premium')
    .delete()
    .match({ subject_type: subjectType, subject_id: subjectId });
  if (error) throw new Error(error.message);
  premiumCache.clear();
}

// ─── Blacklist ────────────────────────────────────────────────────────────────

/** Loaded wholesale at boot: it is small, and consulted on every message. */
const blacklist = { user: new Set<string>(), guild: new Set<string>() };

export async function loadBlacklist(): Promise<void> {
  const { data, error } = await db().from('blacklist').select('*');
  if (error) {
    log.warn({ err: error.message }, 'loadBlacklist failed');
    return;
  }
  blacklist.user.clear();
  blacklist.guild.clear();
  for (const row of (data ?? []) as BlacklistRow[]) {
    blacklist[row.subject_type].add(row.subject_id);
  }
  log.info(
    { users: blacklist.user.size, guilds: blacklist.guild.size },
    'Blacklist loaded',
  );
}

export function isBlacklisted(userId: string, guildId: string | null): boolean {
  return blacklist.user.has(userId) || (guildId !== null && blacklist.guild.has(guildId));
}

export async function addToBlacklist(
  subjectType: 'user' | 'guild',
  subjectId: string,
  reason?: string,
): Promise<void> {
  const { error } = await db()
    .from('blacklist')
    .upsert(
      { subject_type: subjectType, subject_id: subjectId, reason: reason ?? null },
      { onConflict: 'subject_type,subject_id' },
    );
  if (error) throw new Error(error.message);
  blacklist[subjectType].add(subjectId);
}

export async function removeFromBlacklist(
  subjectType: 'user' | 'guild',
  subjectId: string,
): Promise<void> {
  const { error } = await db()
    .from('blacklist')
    .delete()
    .match({ subject_type: subjectType, subject_id: subjectId });
  if (error) throw new Error(error.message);
  blacklist[subjectType].delete(subjectId);
}
