/**
 * Supabase connection.
 *
 * The bot is a trusted backend and connects with the service_role key, which
 * bypasses RLS. Never expose this client or its key to anything user-facing.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createLogger } from '../utils/logger.js';
import type { AppConfig } from '../config/index.js';

const log = createLogger('db');

let client: SupabaseClient | null = null;

export function initDatabase(config: AppConfig): SupabaseClient {
  if (client) return client;

  client = createClient(config.SUPABASE_URL, config.SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'nim-tts-bot' } },
  });

  log.info('Supabase client initialised');
  return client;
}

export function db(): SupabaseClient {
  if (!client) {
    throw new Error('Database not initialised — call initDatabase() first.');
  }
  return client;
}

/** Lightweight connectivity probe used by /status and boot checks. */
export async function pingDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    const { error } = await db().from('users').select('id', { head: true, count: 'exact' }).limit(1);
    if (error) throw new Error(error.message);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
