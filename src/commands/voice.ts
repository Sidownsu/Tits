/**
 * /voice — interactive voice picker.
 *
 * Three cascading select menus (locale → speaker → emotion) rendered inside a
 * Components V2 container, plus a preview button. Selections persist to the
 * user's row immediately, so the menu doubles as the settings surface.
 *
 * Custom ids encode the action only; current state is read back from the user's
 * stored preferences on each interaction. That keeps the component persistent
 * across restarts — no in-memory session state to lose.
 */
import { SlashCommandBuilder } from 'discord.js';

import {
  EMOTION_LABELS,
  LOCALE_LABELS,
  emotionsFor,
  localesAvailable,
  resolveVoice,
  speakersFor,
  type Locale,
} from '../nim/voices.js';
import {
  getUser,
  toEffectivePreferences,
  updateUser,
} from '../database/repositories/userRepository.js';
import { button, buttonRow, container, select, selectRow, v2Flags } from '../ui/components.js';
import type { BotContext } from '../core/context.js';
import type { Command } from './types.js';
import type { UserRow } from '../database/types.js';

export const VOICE_IDS = {
  locale: 'voice:locale',
  speaker: 'voice:speaker',
  emotion: 'voice:emotion',
  preview: 'voice:preview',
  reset: 'voice:reset',
} as const;

/**
 * Render the picker for a user's current selection.
 * Shared by the slash command and by every component interaction that updates it.
 */
export function buildVoicePicker(user: UserRow): {
  components: unknown[];
  flags: number;
} {
  const locales = localesAvailable();
  const currentLocale = (locales.includes(user.locale as Locale)
    ? user.locale
    : (locales[0] ?? 'en-US')) as Locale;

  const speakers = speakersFor(currentLocale);
  const currentSpeaker = speakers.includes(user.speaker)
    ? user.speaker
    : (speakers[0] ?? user.speaker);

  const emotions = emotionsFor(currentLocale, currentSpeaker);
  const currentEmotion = emotions.includes(user.emotion as never)
    ? user.emotion
    : (emotions[0] ?? 'Neutral');

  const resolved = resolveVoice(currentLocale, currentSpeaker, currentEmotion);

  const header = container({
    color: 'primary',
    sections: [
      '### Voice settings',
      [
        `**Language** ${LOCALE_LABELS[currentLocale] ?? currentLocale}`,
        `**Speaker** ${currentSpeaker}`,
        `**Style** ${EMOTION_LABELS[currentEmotion as keyof typeof EMOTION_LABELS] ?? currentEmotion}`,
        '',
        `-# Resolves to \`${resolved.name}\``,
      ].join('\n'),
    ],
    separators: true,
  });

  const localeRow = selectRow(
    select({
      id: VOICE_IDS.locale,
      placeholder: 'Language',
      choices: locales.map((l) => ({
        label: LOCALE_LABELS[l] ?? l,
        value: l,
        default: l === currentLocale,
      })),
    }),
  );

  const speakerRow = selectRow(
    select({
      id: VOICE_IDS.speaker,
      placeholder: 'Speaker',
      choices: speakers.map((s) => ({
        label: s,
        value: s,
        default: s === currentSpeaker,
      })),
    }),
  );

  const emotionRow = selectRow(
    select({
      id: VOICE_IDS.emotion,
      placeholder: 'Style',
      choices: emotions.map((e) => ({
        label: EMOTION_LABELS[e] ?? e,
        value: e,
        default: e === currentEmotion,
      })),
    }),
  );

  const actions = buttonRow(
    button({ id: VOICE_IDS.preview, label: 'Preview', style: 'Primary', emoji: '🔊' }),
    button({ id: VOICE_IDS.reset, label: 'Reset', style: 'Secondary' }),
  );

  return {
    components: [header, localeRow, speakerRow, emotionRow, actions],
    flags: v2Flags(true),
  };
}

export const voice: Command = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Choose how you sound — language, speaker and style'),

  async execute(interaction, _ctx: BotContext) {
    const user = await getUser(interaction.user.id, interaction.user.username);
    const picker = buildVoicePicker(user);

    await interaction.reply({
      components: picker.components as never,
      flags: picker.flags,
    });
  },
};

/**
 * Apply a select-menu choice and re-render.
 *
 * Changing locale can orphan the current speaker/emotion (not every speaker
 * exists in every locale), so the new combination is re-resolved and the
 * resolved values are what get persisted.
 */
export async function applyVoiceSelection(
  userId: string,
  field: 'locale' | 'speaker' | 'emotion',
  value: string,
): Promise<UserRow> {
  const user = await getUser(userId);
  const next = { ...user, [field]: value };

  const resolved = resolveVoice(next.locale, next.speaker, next.emotion);

  return updateUser(userId, {
    locale: resolved.locale,
    speaker: resolved.speaker,
    emotion: resolved.emotion,
  });
}

/** Preferences for a preview clip, resolved the same way playback would. */
export async function previewPreferences(userId: string) {
  const user = await getUser(userId);
  return toEffectivePreferences(user);
}
