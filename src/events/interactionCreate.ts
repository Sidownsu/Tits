/**
 * Interaction router: slash commands, autocomplete and message components.
 *
 * Component custom ids are namespaced `feature:action`, so a single dispatcher
 * can route them without a registry. Because the voice picker reads its state
 * from the database rather than memory, its components keep working after a
 * restart — no "this interaction failed" on stale messages.
 */
import { MessageFlags, type ButtonInteraction, type Interaction } from 'discord.js';

import { createLogger } from '../utils/logger.js';
import { commandMap } from '../commands/index.js';
import { VOICE_IDS, applyVoiceSelection, buildVoicePicker } from '../commands/voice.js';
import { describeFailure } from '../commands/speak.js';
import { getUser, resetUser } from '../database/repositories/userRepository.js';
import { toEffectivePreferences } from '../database/repositories/userRepository.js';
import { isBlacklisted } from '../database/repositories/ttsRepository.js';
import { DEFAULT_SHAPING } from '../voice/audio.js';
import type { BotContext } from '../core/context.js';

const log = createLogger('event:interaction');

const PREVIEW_TEXT =
  'This is how I will sound when I read your messages out loud.';

export async function onInteractionCreate(
  interaction: Interaction,
  ctx: BotContext,
): Promise<void> {
  try {
    if (interaction.isAutocomplete()) {
      const command = commandMap.get(interaction.commandName);
      await command?.autocomplete?.(interaction, ctx);
      return;
    }

    if (interaction.isChatInputCommand()) {
      const command = commandMap.get(interaction.commandName);
      if (!command) {
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
        return;
      }

      if (isBlacklisted(interaction.user.id, interaction.guildId)) {
        await interaction.reply({
          content: 'You are not permitted to use this bot.',
          ephemeral: true,
        });
        return;
      }

      await command.execute(interaction, ctx);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const [namespace] = interaction.customId.split(':');
      if (namespace !== 'voice') return;

      const field =
        interaction.customId === VOICE_IDS.locale
          ? 'locale'
          : interaction.customId === VOICE_IDS.speaker
            ? 'speaker'
            : 'emotion';

      const value = interaction.values[0];
      if (!value) return;

      const user = await applyVoiceSelection(interaction.user.id, field, value);
      const picker = buildVoicePicker(user);

      await interaction.update({ components: picker.components as never });
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === VOICE_IDS.reset) {
        const user = await resetUser(interaction.user.id);
        const picker = buildVoicePicker(user);
        await interaction.update({ components: picker.components as never });
        return;
      }

      if (interaction.customId === VOICE_IDS.preview) {
        await handlePreview(interaction, ctx);
        return;
      }
    }
  } catch (err) {
    log.error({ err, type: interaction.type }, 'Interaction handler threw');
    await replyWithError(interaction, 'Something went wrong handling that.');
  }
}

/**
 * Play a sample of the user's current voice into the channel they are in.
 *
 * Deliberately bypasses the cache: the whole point is to hear the voice they
 * just selected, and caching a preview would pollute the cache with a string no
 * one actually says.
 */
async function handlePreview(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!interaction.guildId) {
    await interaction.editReply({ content: 'Previews only work in a server.' });
    return;
  }

  const session = ctx.sessions.get(interaction.guildId);
  if (!session) {
    await interaction.editReply({
      content: 'I need to be in a voice channel to play a preview — run `/join`.',
    });
    return;
  }

  try {
    const user = await getUser(interaction.user.id, interaction.user.username);
    const preferences = toEffectivePreferences(user);

    const outcome = await ctx.tts.synthesize({
      text: PREVIEW_TEXT,
      preferences,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      maxChars: 200,
      bypassCache: true,
    });

    session.enqueue({
      id: `preview-${interaction.user.id}-${Date.now()}`,
      userId: interaction.user.id,
      pcm: outcome.pcm,
      sampleRateHz: outcome.sampleRateHz,
      shaping: {
        ...DEFAULT_SHAPING,
        speed: preferences.speed,
        pitchSemitones: preferences.pitchSemitones,
        volume: preferences.volume,
      },
      preview: 'voice preview',
      priority: true,
      enqueuedAt: Date.now(),
    });

    await interaction.editReply({
      content: `Playing a preview of **${outcome.voiceName}**.`,
    });
  } catch (err) {
    await interaction.editReply({ content: describeFailure(err) });
  }
}

/** Reply with an error regardless of whether the interaction was deferred. */
async function replyWithError(interaction: Interaction, content: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch {
    // The interaction token expired; nothing more we can do.
  }
}
