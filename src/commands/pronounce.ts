/**
 * /pronounce — pronunciation dictionary.
 *
 * Two scopes: personal entries anyone can set for themselves, and server-wide
 * entries that need Manage Guild. Server entries load first at synthesis time
 * so a personal override always wins on conflict.
 */
import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import {
  deletePronunciation,
  listPronunciations,
  setPronunciation,
} from '../database/repositories/ttsRepository.js';
import { container, v2Flags } from '../ui/components.js';
import type { BotContext } from '../core/context.js';
import type { Command } from './types.js';

/** Cap per scope so one user cannot bloat every synthesis with regex work. */
const MAX_ENTRIES = 50;

export const pronounce: Command = {
  data: new SlashCommandBuilder()
    .setName('pronounce')
    .setDescription('Teach the bot how to say a word')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add or replace a pronunciation')
        .addStringOption((o) =>
          o
            .setName('word')
            .setDescription('The word as written')
            .setRequired(true)
            .setMaxLength(64),
        )
        .addStringOption((o) =>
          o
            .setName('say')
            .setDescription('How it should sound, spelled phonetically')
            .setRequired(true)
            .setMaxLength(128),
        )
        .addBooleanOption((o) =>
          o
            .setName('server_wide')
            .setDescription('Apply to everyone (needs Manage Server)'),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Delete a pronunciation')
        .addStringOption((o) =>
          o.setName('word').setDescription('The word to forget').setRequired(true),
        )
        .addBooleanOption((o) =>
          o.setName('server_wide').setDescription('Remove the server-wide entry'),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Show pronunciations')
        .addBooleanOption((o) =>
          o.setName('server_wide').setDescription('Show the server dictionary'),
        ),
    ) as SlashCommandBuilder,

  async execute(interaction, _ctx: BotContext) {
    const sub = interaction.options.getSubcommand();
    const serverWide = interaction.options.getBoolean('server_wide') ?? false;

    if (serverWide) {
      if (!interaction.inCachedGuild()) {
        await interaction.reply({
          content: 'Server-wide entries only work inside a server.',
          ephemeral: true,
        });
        return;
      }
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: 'Server-wide pronunciations need the **Manage Server** permission.',
          ephemeral: true,
        });
        return;
      }
    }

    const scopeType = serverWide ? 'guild' : 'user';
    const scopeId = serverWide ? interaction.guildId! : interaction.user.id;
    const scopeLabel = serverWide ? 'server' : 'personal';

    switch (sub) {
      case 'add': {
        const word = interaction.options.getString('word', true).trim();
        const say = interaction.options.getString('say', true).trim();

        if (!word || !say) {
          await interaction.reply({ content: 'Both fields must be non-empty.', ephemeral: true });
          return;
        }

        const existing = await listPronunciations(scopeType, scopeId);
        const isNew = !existing.some((e) => e.from_text.toLowerCase() === word.toLowerCase());
        if (isNew && existing.length >= MAX_ENTRIES) {
          await interaction.reply({
            content: `That dictionary is full (${MAX_ENTRIES} entries). Remove one first.`,
            ephemeral: true,
          });
          return;
        }

        await setPronunciation(scopeType, scopeId, word, say);
        await interaction.reply({
          content: `Added to the ${scopeLabel} dictionary: **${word}** → “${say}”`,
          ephemeral: true,
        });
        return;
      }

      case 'remove': {
        const word = interaction.options.getString('word', true).trim();
        await deletePronunciation(scopeType, scopeId, word);
        await interaction.reply({
          content: `Removed **${word}** from the ${scopeLabel} dictionary.`,
          ephemeral: true,
        });
        return;
      }

      default: {
        const entries = await listPronunciations(scopeType, scopeId);
        const body =
          entries.length === 0
            ? '_Nothing here yet. Add one with `/pronounce add`._'
            : entries
                .slice(0, 40)
                .map((e) => `• **${e.from_text}** → ${e.to_text}`)
                .join('\n');

        await interaction.reply({
          components: [
            container({
              color: 'primary',
              sections: [
                `### ${serverWide ? 'Server' : 'Your'} pronunciations (${entries.length}/${MAX_ENTRIES})`,
                body,
              ],
              separators: true,
            }),
          ],
          flags: v2Flags(true),
        });
      }
    }
  },
};
