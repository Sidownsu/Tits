/** /tts — speak a one-off message without configuring the channel reader. */
import { SlashCommandBuilder } from 'discord.js';
import type { GuildMember } from 'discord.js';

import { createLogger } from '../utils/logger.js';
import { getGuild } from '../database/repositories/guildRepository.js';
import {
  getUser,
  toEffectivePreferences,
} from '../database/repositories/userRepository.js';
import {
  getPronunciationMap,
  isBlacklisted,
  isPremium,
} from '../database/repositories/ttsRepository.js';
import { EmptyTextError } from '../voice/ttsService.js';
import { QueueFullError } from '../voice/session.js';
import { NimError } from '../nim/types.js';
import { NoKeysAvailableError } from '../nim/keyPool.js';
import { buildResolvers } from '../core/resolvers.js';
import { container, v2Flags } from '../ui/components.js';
import { DEFAULT_SHAPING } from '../voice/audio.js';
import type { BotContext } from '../core/context.js';
import type { Command } from './types.js';

const log = createLogger('cmd:tts');

/** Turn any pipeline failure into a message a user can act on. */
export function describeFailure(err: unknown): string {
  if (err instanceof EmptyTextError) {
    return 'There was nothing speakable left after stripping formatting.';
  }
  if (err instanceof QueueFullError) {
    return `The queue is full (${err.limit} items). Wait for it to drain, or use \`/clear\`.`;
  }
  if (err instanceof NoKeysAvailableError) {
    const wait = err.retryAfterMs
      ? ` Try again in about ${Math.ceil(err.retryAfterMs / 1000)}s.`
      : '';
    return `Every NVIDIA API key is rate-limited or cooling down right now.${wait}`;
  }
  if (err instanceof NimError) {
    switch (err.kind) {
      case 'rate-limited':
        return 'NVIDIA rate-limited every key I tried. Give it a moment.';
      case 'unauthorized':
        return 'NVIDIA rejected the API key. An admin should check `/status`.';
      case 'timeout':
        return 'Speech generation timed out. Try a shorter message.';
      case 'bad-request':
        return 'NVIDIA rejected that request — the text or voice may be unsupported.';
      default:
        return 'Speech generation failed upstream. Try again shortly.';
    }
  }
  return 'Something went wrong generating speech.';
}

export const tts: Command = {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Speak a message in the voice channel')
    .addStringOption((o) =>
      o
        .setName('message')
        .setDescription('What should I say?')
        .setRequired(true)
        .setMaxLength(2000),
    )
    .addBooleanOption((o) =>
      o
        .setName('priority')
        .setDescription('Jump the queue (premium only)'),
    ) as SlashCommandBuilder,

  async execute(interaction, ctx: BotContext) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
      return;
    }

    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    if (isBlacklisted(userId, guildId)) {
      await interaction.reply({ content: 'You are not permitted to use this bot.', ephemeral: true });
      return;
    }

    const session = ctx.sessions.get(guildId);
    if (!session) {
      await interaction.reply({
        content: 'I am not in a voice channel — run `/join` first.',
        ephemeral: true,
      });
      return;
    }

    const text = interaction.options.getString('message', true);
    const guildSettings = await getGuild(guildId, interaction.guild.name);

    const verdict = ctx.rateLimiter.check(userId, text, guildSettings.user_cooldown_ms);
    if (!verdict.allowed) {
      const seconds = Math.ceil((verdict.retryAfterMs ?? 0) / 1000);
      await interaction.reply({
        content:
          verdict.reason === 'duplicate'
            ? 'You just said that — try something different.'
            : `Slow down a moment (${seconds}s).`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const premium = await isPremium(userId, guildId);
    const [user, pronunciations] = await Promise.all([
      getUser(userId, interaction.user.username),
      getPronunciationMap(userId, guildId),
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

    try {
      const outcome = await ctx.tts.synthesize({
        text,
        preferences,
        userId,
        guildId,
        pronunciations,
        resolvers: buildResolvers(interaction.guild),
        maxChars,
      });

      const wantsPriority = interaction.options.getBoolean('priority') ?? false;

      session.enqueue({
        id: `${interaction.id}`,
        userId,
        pcm: outcome.pcm,
        sampleRateHz: outcome.sampleRateHz,
        shaping: {
          ...DEFAULT_SHAPING,
          speed: preferences.speed,
          pitchSemitones: preferences.pitchSemitones,
          volume: preferences.volume,
        },
        preview: outcome.spokenText.slice(0, 80),
        // Priority is a premium capability; silently downgrade rather than
        // erroring, so the message still gets spoken.
        priority: wantsPriority && premium,
        enqueuedAt: Date.now(),
      });

      ctx.rateLimiter.commit(userId, text);

      const position = session.queueLength;
      const cacheNote =
        outcome.cacheHits === outcome.chunkCount ? ' · served from cache' : '';

      await interaction.editReply({
        components: [
          container({
            color: 'success',
            sections: [
              position > 0 ? `### Queued (position ${position})` : '### Speaking now',
              `> ${outcome.spokenText.slice(0, 300)}`,
              `-# ${outcome.voiceName} · ${outcome.latencyMs}ms${cacheNote}`,
            ],
          }),
        ],
        flags: v2Flags(true),
      });
    } catch (err) {
      log.warn({ err, userId, guildId }, '/tts failed');
      await interaction.editReply({ content: describeFailure(err) });
    }
  },
};

/** `/speak` is an alias so both names in the spec resolve to the same handler. */
export const speak: Command = {
  data: new SlashCommandBuilder()
    .setName('speak')
    .setDescription('Speak a message in the voice channel (alias of /tts)')
    .addStringOption((o) =>
      o
        .setName('message')
        .setDescription('What should I say?')
        .setRequired(true)
        .setMaxLength(2000),
    )
    .addBooleanOption((o) =>
      o.setName('priority').setDescription('Jump the queue (premium only)'),
    ) as SlashCommandBuilder,

  execute: tts.execute,
};

/** Exposed for the message handler, which shares this member context helper. */
export function memberDisplayName(member: GuildMember | null): string | null {
  return member?.displayName ?? null;
}
