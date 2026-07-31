/**
 * /settings — playback shaping and behaviour toggles.
 *
 * Speed, pitch and volume are applied in ffmpeg after synthesis rather than
 * passed to Magpie, which exposes no such parameters. That is why the ranges
 * here are ffmpeg's practical limits, not the model's.
 */
import { SlashCommandBuilder } from 'discord.js';

import {
  getUser,
  resetUser,
  updateUser,
} from '../database/repositories/userRepository.js';
import { EMOTION_LABELS, LOCALE_LABELS, resolveVoice } from '../nim/voices.js';
import { container, meter, v2Flags } from '../ui/components.js';
import type { BotContext } from '../core/context.js';
import type { Command } from './types.js';
import type { UserRow } from '../database/types.js';

function renderProfile(user: UserRow): string {
  const resolved = resolveVoice(user.locale, user.speaker, user.emotion);
  const speed = Number(user.speed);
  const volume = Number(user.volume);

  return [
    `**Language** ${LOCALE_LABELS[user.locale as keyof typeof LOCALE_LABELS] ?? user.locale}`,
    `**Speaker** ${user.speaker}`,
    `**Style** ${EMOTION_LABELS[user.emotion as keyof typeof EMOTION_LABELS] ?? user.emotion}`,
    '',
    `**Speed** \`${meter((speed - 0.5) / 1.5)}\` ${speed.toFixed(2)}×`,
    `**Pitch** \`${meter((user.pitch_semitones + 12) / 24)}\` ${user.pitch_semitones > 0 ? '+' : ''}${user.pitch_semitones} st`,
    `**Volume** \`${meter(volume / 2)}\` ${Math.round(volume * 100)}%`,
    '',
    `**Read URLs** ${user.read_urls ? 'yes' : 'no'} · **Read emoji** ${user.read_emoji ? 'yes' : 'no'}`,
    '',
    `-# ${resolved.name}`,
  ].join('\n');
}

export const settings: Command = {
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('View and adjust your speech settings')
    .addSubcommand((s) => s.setName('show').setDescription('Show your current settings'))
    .addSubcommand((s) =>
      s
        .setName('speed')
        .setDescription('How fast you are spoken (0.5–2.0)')
        .addNumberOption((o) =>
          o
            .setName('value')
            .setDescription('1.0 is normal')
            .setRequired(true)
            .setMinValue(0.5)
            .setMaxValue(2.0),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('pitch')
        .setDescription('Pitch shift in semitones (−12…+12)')
        .addIntegerOption((o) =>
          o
            .setName('value')
            .setDescription('0 is unshifted')
            .setRequired(true)
            .setMinValue(-12)
            .setMaxValue(12),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('volume')
        .setDescription('Playback volume (0–200%)')
        .addIntegerOption((o) =>
          o
            .setName('percent')
            .setDescription('100 is normal')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(200),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('reading')
        .setDescription('Control what gets read aloud')
        .addBooleanOption((o) =>
          o.setName('urls').setDescription('Read link addresses instead of just "link"'),
        )
        .addBooleanOption((o) =>
          o.setName('emoji').setDescription('Read custom emoji names'),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('name')
        .setDescription('How the bot pronounces your name when announcing you')
        .addStringOption((o) =>
          o.setName('value').setDescription('Leave empty to clear').setMaxLength(64),
        ),
    )
    .addSubcommand((s) =>
      s.setName('reset').setDescription('Restore every setting to its default'),
    ) as SlashCommandBuilder,

  async execute(interaction, _ctx: BotContext) {
    const userId = interaction.user.id;
    const sub = interaction.options.getSubcommand();

    let user: UserRow;
    let note: string | null = null;

    switch (sub) {
      case 'speed': {
        const value = interaction.options.getNumber('value', true);
        user = await updateUser(userId, { speed: value });
        note = `Speed set to **${value.toFixed(2)}×**.`;
        break;
      }
      case 'pitch': {
        const value = interaction.options.getInteger('value', true);
        user = await updateUser(userId, { pitch_semitones: value });
        note = `Pitch set to **${value > 0 ? '+' : ''}${value} semitones**.`;
        break;
      }
      case 'volume': {
        const percent = interaction.options.getInteger('percent', true);
        user = await updateUser(userId, { volume: percent / 100 });
        note = `Volume set to **${percent}%**.`;
        break;
      }
      case 'reading': {
        const urls = interaction.options.getBoolean('urls');
        const emoji = interaction.options.getBoolean('emoji');
        if (urls === null && emoji === null) {
          await interaction.reply({
            content: 'Set at least one of `urls` or `emoji`.',
            ephemeral: true,
          });
          return;
        }
        user = await updateUser(userId, {
          ...(urls !== null ? { read_urls: urls } : {}),
          ...(emoji !== null ? { read_emoji: emoji } : {}),
        });
        note = 'Reading preferences updated.';
        break;
      }
      case 'name': {
        const value = interaction.options.getString('value');
        user = await updateUser(userId, { spoken_name: value?.trim() || null });
        note = value ? `I will call you **${value}**.` : 'Cleared your spoken name.';
        break;
      }
      case 'reset': {
        user = await resetUser(userId);
        note = 'All settings restored to defaults.';
        break;
      }
      default: {
        user = await getUser(userId, interaction.user.username);
      }
    }

    await interaction.reply({
      components: [
        container({
          color: 'primary',
          sections: [
            '### Your speech settings',
            renderProfile(user),
            ...(note ? [`-# ${note}`] : []),
          ],
          separators: true,
        }),
      ],
      flags: v2Flags(true),
    });
  },
};
