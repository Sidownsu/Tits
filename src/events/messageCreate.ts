/**
 * The channel reader — the bot's primary job.
 *
 * Runs on every message in every guild, so the early-exit ladder is ordered by
 * cost: cheap in-memory checks first, database reads only once a message has
 * survived them, and synthesis last.
 */
import { ChannelType, type Message } from 'discord.js';

import { createLogger } from '../utils/logger.js';
import { getGuild, getIgnores } from '../database/repositories/guildRepository.js';
import {
  getUser,
  toEffectivePreferences,
} from '../database/repositories/userRepository.js';
import {
  getPronunciationMap,
  isBlacklisted,
  isPremium,
} from '../database/repositories/ttsRepository.js';
import { buildResolvers } from '../core/resolvers.js';
import { DEFAULT_SHAPING } from '../voice/audio.js';
import { EmptyTextError } from '../voice/ttsService.js';
import { QueueFullError } from '../voice/session.js';
import type { BotContext } from '../core/context.js';

const log = createLogger('event:message');

/** Message types that are noise when spoken aloud. */
function isSpeakableType(message: Message): boolean {
  return (
    message.type === 0 /* Default */ ||
    message.type === 19 /* Reply */ ||
    message.type === 21 /* ThreadStarterMessage */
  );
}

export async function onMessageCreate(message: Message, ctx: BotContext): Promise<void> {
  // ── Cheap rejects ──────────────────────────────────────────────────────────
  if (message.author.bot || message.system) return;
  if (!message.inGuild()) return;
  if (!isSpeakableType(message)) return;

  const session = ctx.sessions.get(message.guildId);
  if (!session) return; // Not connected here — nothing to do.

  if (session.textChannelId && message.channelId !== session.textChannelId) return;

  if (isBlacklisted(message.author.id, message.guildId)) return;

  // Attachments with no text are not worth announcing.
  const raw = message.content.trim();
  if (!raw) return;

  // Common convention: a leading backslash or slash suppresses TTS.
  if (raw.startsWith('\\') || raw.startsWith('/')) return;

  try {
    const guildSettings = await getGuild(message.guildId, message.guild?.name);

    if (!guildSettings.read_all_messages) return;

    // ── Ignore lists ─────────────────────────────────────────────────────────
    const ignores = await getIgnores(message.guildId);
    if (ignores.channel.has(message.channelId)) return;
    if (ignores.user.has(message.author.id)) return;
    if (
      message.member &&
      message.member.roles.cache.some((role) => ignores.role.has(role.id))
    ) {
      return;
    }

    // Threads inherit their parent channel's ignore state.
    if (
      message.channel.type === ChannelType.PublicThread ||
      message.channel.type === ChannelType.PrivateThread
    ) {
      const parentId = message.channel.parentId;
      if (parentId && ignores.channel.has(parentId)) return;
    }

    // ── Rate limiting ────────────────────────────────────────────────────────
    const verdict = ctx.rateLimiter.check(
      message.author.id,
      raw,
      guildSettings.user_cooldown_ms,
    );
    if (!verdict.allowed) return; // Silent: reacting would be noisier than dropping.

    // ── Preferences ──────────────────────────────────────────────────────────
    const [user, pronunciations, premium] = await Promise.all([
      getUser(message.author.id, message.author.username),
      getPronunciationMap(message.author.id, message.guildId),
      isPremium(message.author.id, message.guildId),
    ]);

    const preferences = toEffectivePreferences(user, {
      locale: guildSettings.default_locale,
      speaker: guildSettings.default_speaker,
      emotion: guildSettings.default_emotion,
    });

    const maxChars = Math.min(
      guildSettings.max_message_chars,
      premium ? ctx.config.MAX_MESSAGE_CHARS_PREMIUM : ctx.config.MAX_MESSAGE_CHARS,
    );

    // Optionally prefix with the author's name.
    const spokenName =
      preferences.spokenName ?? message.member?.displayName ?? message.author.username;
    const text = guildSettings.announce_speaker ? `${spokenName} says: ${raw}` : raw;

    // ── Synthesis ────────────────────────────────────────────────────────────
    const outcome = await ctx.tts.synthesize({
      text,
      preferences,
      userId: message.author.id,
      guildId: message.guildId,
      pronunciations,
      resolvers: buildResolvers(message.guild),
      maxChars,
    });

    session.enqueue({
      id: message.id,
      userId: message.author.id,
      pcm: outcome.pcm,
      sampleRateHz: outcome.sampleRateHz,
      shaping: {
        ...DEFAULT_SHAPING,
        speed: preferences.speed,
        pitchSemitones: preferences.pitchSemitones,
        volume: preferences.volume,
      },
      preview: outcome.spokenText.slice(0, 80),
      priority: premium,
      enqueuedAt: Date.now(),
    });

    ctx.rateLimiter.commit(message.author.id, raw);
  } catch (err) {
    // Nothing speakable, or a full queue, are normal outcomes — not errors.
    if (err instanceof EmptyTextError || err instanceof QueueFullError) return;

    log.warn(
      { err, guildId: message.guildId, userId: message.author.id },
      'Failed to speak message',
    );

    // React rather than reply: a failure notice in chat for every hiccup would
    // be far more disruptive than a quiet marker on the message.
    void message.react('⚠️').catch(() => undefined);
  }
}
