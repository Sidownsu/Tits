/** /help — command reference, honest about what this build supports. */
import { SlashCommandBuilder } from 'discord.js';

import { EMOTIONS, LOCALE_LABELS, localesAvailable } from '../nim/voices.js';
import { container, v2Flags } from '../ui/components.js';
import type { BotContext } from '../core/context.js';
import type { Command } from './types.js';

export const help: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('How to use the bot'),

  async execute(interaction, _ctx: BotContext) {
    const locales = localesAvailable();

    await interaction.reply({
      components: [
        container({
          color: 'primary',
          sections: [
            '### Text-to-speech, powered by NVIDIA Magpie',

            [
              '**Getting started**',
              '`/join` — bring me into your voice channel',
              '`/tts <message>` — say something',
              '`/leave` — disconnect',
              '',
              'Once joined, I read the linked text channel automatically if the',
              'server has that enabled.',
            ].join('\n'),

            [
              '**Your voice**',
              '`/voice` — pick language, speaker and style interactively',
              '`/settings` — speed, pitch, volume and reading options',
              '`/favorites` — save voices you like',
              '`/pronounce` — teach me how to say a word',
              '`/history` — what I have said for you',
            ].join('\n'),

            [
              '**Playback**',
              '`/queue` `/skip` `/pause` `/resume` `/stop` `/clear`',
              '',
              'You can always skip or clear your own messages. Pausing and',
              'stopping affect everyone, so they need Manage Messages.',
            ].join('\n'),

            [
              '**Admin**',
              '`/admin` — channel, limits, ignore lists, blacklist, key resets',
              '`/status` — API key health and diagnostics',
            ].join('\n'),

            [
              '**What voices exist**',
              `${locales.length} languages: ${locales.map((l) => LOCALE_LABELS[l] ?? l).join(', ')}`,
              '',
              `Styles: ${EMOTIONS.join(', ')}`,
              '',
              '-# Magpie offers a fixed set of named speakers per language, not',
              '-# arbitrary character voices, and does not support British,',
              '-# Australian or Indian English accents. `/voice` only ever shows',
              '-# combinations that actually exist.',
            ].join('\n'),
          ],
          separators: true,
        }),
      ],
      flags: v2Flags(true),
    });
  },
};
