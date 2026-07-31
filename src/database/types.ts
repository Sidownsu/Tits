/** Row shapes mirroring supabase/migrations/0001_initial_schema.sql. */

export interface UserRow {
  id: string;
  username: string | null;
  created_at: string;
  updated_at: string;
  locale: string;
  speaker: string;
  emotion: string;
  speed: number;
  pitch_semitones: number;
  volume: number;
  read_urls: boolean;
  read_emoji: boolean;
  nsfw_filter: boolean;
  auto_join: boolean;
  spoken_name: string | null;
}

export interface GuildRow {
  id: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  tts_channel_id: string | null;
  read_all_messages: boolean;
  announce_speaker: boolean;
  max_message_chars: number;
  user_cooldown_ms: number;
  auto_leave_seconds: number;
  default_locale: string;
  default_speaker: string;
  default_emotion: string;
  is_premium: boolean;
}

export type IgnoreEntityType = 'channel' | 'role' | 'user';

export interface GuildIgnoreRow {
  guild_id: string;
  entity_type: IgnoreEntityType;
  entity_id: string;
  created_at: string;
}

export interface FavoriteRow {
  user_id: string;
  voice_name: string;
  created_at: string;
}

export interface VoiceHistoryRow {
  id: number;
  user_id: string;
  guild_id: string | null;
  text: string;
  voice_name: string;
  cached: boolean;
  created_at: string;
}

export interface PronunciationRow {
  id: string;
  scope_type: 'user' | 'guild';
  scope_id: string;
  from_text: string;
  to_text: string;
  created_at: string;
}

export interface UsageLogInsert {
  user_id: string | null;
  guild_id: string | null;
  voice_name: string | null;
  char_count: number;
  chunk_count: number;
  cache_hit: boolean;
  latency_ms: number | null;
  success: boolean;
  error_kind: string | null;
}

export interface PremiumRow {
  subject_type: 'user' | 'guild';
  subject_id: string;
  tier: 'plus' | 'pro';
  granted_at: string;
  expires_at: string | null;
  note: string | null;
}

export interface BlacklistRow {
  subject_type: 'user' | 'guild';
  subject_id: string;
  reason: string | null;
  created_at: string;
}

/** Resolved preferences the TTS pipeline actually consumes. */
export interface EffectivePreferences {
  locale: string;
  speaker: string;
  emotion: string;
  speed: number;
  pitchSemitones: number;
  volume: number;
  readUrls: boolean;
  readEmoji: boolean;
  spokenName: string | null;
}
