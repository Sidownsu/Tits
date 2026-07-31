/**
 * Guild settings and ignore lists.
 *
 * Ignore lists are cached as Sets because `messageCreate` consults them for
 * every message in every configured guild — this must be an O(1) memory lookup,
 * not a query.
 */
import { db } from '../client.js';
import { createLogger } from '../../utils/logger.js';
import { DEFAULT_EMOTION, DEFAULT_LOCALE, DEFAULT_SPEAKER } from '../../nim/voices.js';
import type { GuildIgnoreRow, GuildRow, IgnoreEntityType } from '../types.js';

const log = createLogger('db:guilds');
const TABLE = 'guilds';
const IGNORES_TABLE = 'guild_ignores';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface GuildCacheEntry {
  row: GuildRow;
  ignores: Record<IgnoreEntityType, Set<string>>;
  expiresAt: number;
}

const cache = new Map<string, GuildCacheEntry>();

function emptyIgnores(): Record<IgnoreEntityType, Set<string>> {
  return { channel: new Set(), role: new Set(), user: new Set() };
}

function buildDefaultRow(guildId: string, name?: string): GuildRow {
  const now = new Date().toISOString();
  return {
    id: guildId,
    name: name ?? null,
    created_at: now,
    updated_at: now,
    tts_channel_id: null,
    read_all_messages: true,
    announce_speaker: false,
    max_message_chars: 500,
    user_cooldown_ms: 2000,
    auto_leave_seconds: 300,
    default_locale: DEFAULT_LOCALE,
    default_speaker: DEFAULT_SPEAKER,
    default_emotion: DEFAULT_EMOTION,
    is_premium: false,
  };
}

export async function getGuild(guildId: string, name?: string): Promise<GuildRow> {
  const entry = await loadGuild(guildId, name);
  return entry.row;
}

export async function getIgnores(
  guildId: string,
): Promise<Record<IgnoreEntityType, Set<string>>> {
  const entry = await loadGuild(guildId);
  return entry.ignores;
}

async function loadGuild(guildId: string, name?: string): Promise<GuildCacheEntry> {
  const cached = cache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  try {
    const [{ data, error }, { data: ignoreRows, error: ignoreError }] = await Promise.all([
      db().from(TABLE).select('*').eq('id', guildId).maybeSingle<GuildRow>(),
      db().from(IGNORES_TABLE).select('*').eq('guild_id', guildId),
    ]);

    if (error) throw new Error(error.message);
    if (ignoreError) throw new Error(ignoreError.message);

    let row = data;
    if (!row) {
      row = buildDefaultRow(guildId, name);
      const { error: insertError } = await db().from(TABLE).insert(row);
      if (insertError && !insertError.message.includes('duplicate')) {
        throw new Error(insertError.message);
      }
    }

    const ignores = emptyIgnores();
    for (const r of (ignoreRows ?? []) as GuildIgnoreRow[]) {
      ignores[r.entity_type]?.add(r.entity_id);
    }

    const entry: GuildCacheEntry = {
      row,
      ignores,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    cache.set(guildId, entry);
    return entry;
  } catch (err) {
    log.error({ err, guildId }, 'loadGuild failed; using defaults');
    return {
      row: buildDefaultRow(guildId, name),
      ignores: emptyIgnores(),
      expiresAt: Date.now() + 30_000,
    };
  }
}

export async function updateGuild(
  guildId: string,
  changes: Partial<Omit<GuildRow, 'id' | 'created_at' | 'updated_at'>>,
): Promise<GuildRow> {
  const current = await getGuild(guildId);
  const merged: GuildRow = { ...current, ...changes, updated_at: new Date().toISOString() };

  const { error } = await db().from(TABLE).upsert(merged, { onConflict: 'id' });
  if (error) throw new Error(error.message);

  cache.delete(guildId);
  return merged;
}

export async function addIgnore(
  guildId: string,
  entityType: IgnoreEntityType,
  entityId: string,
): Promise<void> {
  const { error } = await db()
    .from(IGNORES_TABLE)
    .upsert(
      { guild_id: guildId, entity_type: entityType, entity_id: entityId },
      { onConflict: 'guild_id,entity_type,entity_id' },
    );
  if (error) throw new Error(error.message);
  cache.delete(guildId);
}

export async function removeIgnore(
  guildId: string,
  entityType: IgnoreEntityType,
  entityId: string,
): Promise<void> {
  const { error } = await db()
    .from(IGNORES_TABLE)
    .delete()
    .match({ guild_id: guildId, entity_type: entityType, entity_id: entityId });
  if (error) throw new Error(error.message);
  cache.delete(guildId);
}

export function invalidateGuildCache(guildId?: string): void {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}
