/** /history and /favorites — the user's own data. */
import { SlashCommandBuilder } from 'discord.js';

import {
  addFavorite,
  clearHistory,
  getFavorites,
  getHistory,
  removeFavorite,
} from '../database/repositories/ttsRepository.js';
import { getUser } from '../database/repositories/userRepository.js';
import { resolveVoice } from '../nim/voices.js';
import { container, v2Flags } from '../ui/components.js';
import type { BotContext } from '../core/context.js';
import type { Command } from './types.js';

export const history: Command = {
  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription('Recent things the bot has said for you')
    .addSubcommand((s) => s.setName('show').setDescription('List your recent messages'))
    .addSubcommand((s) => s.setName('clear').setDescription('Delete your history')) as SlashCommandBuilder,

  async execute(interaction, _ctx: BotContext) {
    const userId = interaction.user.id;

    if (interaction.options.getSubcommand() === 'clear') {
      await clearHistory(userId);
      await interaction.reply({ content: 'History cleared.', ephemeral: true });
      return;
    }

    const rows = await getHistory(userId, 15);
    const body =
      rows.length === 0
        ? '_Nothing yet._'
        : rows
            .map((r) => {
              const when = Math.floor(new Date(r.created_at).getTime() / 1000);
              const text = r.text.length > 70 ? `${r.text.slice(0, 70)}…` : r.text;
              return `<t:${when}:R> ${r.cached ? '⚡ ' : ''}${text}`;
            })
            .join('\n');

    await interaction.reply({
      components: [
        container({
          color: 'primary',
          sections: ['### Recent messages', body, '-# ⚡ served from cache'],
          separators: true,
        }),
      ],
      flags: v2Flags(true),
    });
  },
};

export const favorites: Command = {
  data: new SlashCommandBuilder()
    .setName('favorites')
    .setDescription('Save voices you like')
    .addSubcommand((s) => s.setName('list').setDescription('Show your saved voices'))
    .addSubcommand((s) =>
      s.setName('add').setDescription('Save your current voice as a favourite'),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove a saved voice')
        .addStringOption((o) =>
          o.setName('voice').setDescription('Full voice name').setRequired(true).setAutocomplete(true),
        ),
    ) as SlashCommandBuilder,

  async execute(interaction, _ctx: BotContext) {
    const userId = interaction.user.id;
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const user = await getUser(userId, interaction.user.username);
      const resolved = resolveVoice(user.locale, user.speaker, user.emotion);
      await addFavorite(userId, resolved.name);
      await interaction.reply({
        content: `Saved **${resolved.speaker}** (${resolved.emotion}, ${resolved.locale}).`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'remove') {
      const voiceName = interaction.options.getString('voice', true);
      await removeFavorite(userId, voiceName);
      await interaction.reply({ content: `Removed **${voiceName}**.`, ephemeral: true });
      return;
    }

    const rows = await getFavorites(userId);
    const body =
      rows.length === 0
        ? '_No favourites yet. Pick a voice with `/voice`, then run `/favorites add`._'
        : rows.map((r) => `• \`${r.voice_name}\``).join('\n');

    await interaction.reply({
      components: [
        container({ color: 'primary', sections: ['### Saved voices', body], separators: true }),
      ],
      flags: v2Flags(true),
    });
  },

  async autocomplete(interaction, _ctx) {
    const rows = await getFavorites(interaction.user.id);
    const focused = interaction.options.getFocused().toLowerCase();
    await interaction.respond(
      rows
        .filter((r) => r.voice_name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map((r) => ({ name: r.voice_name.slice(0, 100), value: r.voice_name })),
    );
  },
};
