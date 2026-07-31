/**
 * /admin — server configuration and operational controls.
 *
 * Every subcommand requires Manage Server, enforced both by Discord's default
 * member permissions and again at execution time (a server owner can loosen the
 * former via integration settings, so the second check is not redundant).
 */
import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import {
  addIgnore,
  getGuild,
  getIgnores,
  removeIgnore,
  updateGuild,
} from '../database/repositories/guildRepository.js';
import { addToBlacklist, removeFromBlacklist } from '../database/repositories/ttsRepository.js';
import { container, v2Flags } from '../ui/components.js';
import type { BotContext } from '../core/context.js';
import type { Command } from './types.js';

export const admin: Command = {
  adminOnly: true,

  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Server configuration and bot operations')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('show').setDescription('Show this server’s configuration'))
    .addSubcommand((s) =>
      s
        .setName('channel')
        .setDescription('Set the text channel the bot reads aloud')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Text channel')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('limits')
        .setDescription('Adjust message length, cooldown and idle timeout')
        .addIntegerOption((o) =>
          o
            .setName('max_chars')
            .setDescription('Longest message that will be spoken')
            .setMinValue(1)
            .setMaxValue(5000),
        )
        .addIntegerOption((o) =>
          o
            .setName('cooldown_ms')
            .setDescription('Per-user cooldown in milliseconds')
            .setMinValue(0)
            .setMaxValue(60_000),
        )
        .addIntegerOption((o) =>
          o
            .setName('auto_leave_seconds')
            .setDescription('Idle seconds before disconnecting (0 disables)')
            .setMinValue(0)
            .setMaxValue(3600),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('behaviour')
        .setDescription('Toggle reading behaviour')
        .addBooleanOption((o) =>
          o
            .setName('read_all')
            .setDescription('Read every message in the channel, not just /tts'),
        )
        .addBooleanOption((o) =>
          o.setName('announce_speaker').setDescription('Prefix messages with the author’s name'),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('ignore')
        .setDescription('Stop reading a channel, role or user')
        .addStringOption((o) =>
          o
            .setName('type')
            .setDescription('What to ignore')
            .setRequired(true)
            .addChoices(
              { name: 'channel', value: 'channel' },
              { name: 'role', value: 'role' },
              { name: 'user', value: 'user' },
            ),
        )
        .addStringOption((o) =>
          o.setName('id').setDescription('The channel, role or user ID').setRequired(true),
        )
        .addBooleanOption((o) =>
          o.setName('remove').setDescription('Un-ignore instead of ignoring'),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('blacklist')
        .setDescription('Block a user from using the bot entirely')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
        .addBooleanOption((o) => o.setName('remove').setDescription('Unblock instead'))
        .addStringOption((o) => o.setName('reason').setDescription('Why')),
    )
    .addSubcommand((s) =>
      s
        .setName('resetkeys')
        .setDescription('Return cooling or disabled NVIDIA keys to rotation')
        .addStringOption((o) =>
          o.setName('key_id').setDescription('Specific key id, e.g. key-2 (default: all)'),
        ),
    )
    .addSubcommand((s) =>
      s.setName('prunecache').setDescription('Trim the audio cache now'),
    ) as SlashCommandBuilder,

  async execute(interaction, ctx: BotContext) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'This command needs the **Manage Server** permission.',
        ephemeral: true,
      });
      return;
    }

    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'channel': {
        const channel = interaction.options.getChannel('channel', true);
        await updateGuild(guildId, { tts_channel_id: channel.id });
        await interaction.reply({
          content: `Now reading from ${channel.toString()}.`,
          ephemeral: true,
        });
        return;
      }

      case 'limits': {
        const maxChars = interaction.options.getInteger('max_chars');
        const cooldown = interaction.options.getInteger('cooldown_ms');
        const autoLeave = interaction.options.getInteger('auto_leave_seconds');

        if (maxChars === null && cooldown === null && autoLeave === null) {
          await interaction.reply({ content: 'Set at least one value.', ephemeral: true });
          return;
        }

        await updateGuild(guildId, {
          ...(maxChars !== null ? { max_message_chars: maxChars } : {}),
          ...(cooldown !== null ? { user_cooldown_ms: cooldown } : {}),
          ...(autoLeave !== null ? { auto_leave_seconds: autoLeave } : {}),
        });
        await interaction.reply({ content: 'Limits updated.', ephemeral: true });
        return;
      }

      case 'behaviour': {
        const readAll = interaction.options.getBoolean('read_all');
        const announce = interaction.options.getBoolean('announce_speaker');

        if (readAll === null && announce === null) {
          await interaction.reply({ content: 'Set at least one option.', ephemeral: true });
          return;
        }

        await updateGuild(guildId, {
          ...(readAll !== null ? { read_all_messages: readAll } : {}),
          ...(announce !== null ? { announce_speaker: announce } : {}),
        });
        await interaction.reply({ content: 'Behaviour updated.', ephemeral: true });
        return;
      }

      case 'ignore': {
        const type = interaction.options.getString('type', true) as
          | 'channel'
          | 'role'
          | 'user';
        const id = interaction.options.getString('id', true).trim();
        const remove = interaction.options.getBoolean('remove') ?? false;

        if (!/^\d{15,25}$/.test(id)) {
          await interaction.reply({
            content: 'That does not look like a Discord ID. Enable Developer Mode and copy the ID.',
            ephemeral: true,
          });
          return;
        }

        if (remove) await removeIgnore(guildId, type, id);
        else await addIgnore(guildId, type, id);

        await interaction.reply({
          content: `${remove ? 'No longer ignoring' : 'Now ignoring'} ${type} \`${id}\`.`,
          ephemeral: true,
        });
        return;
      }

      case 'blacklist': {
        const user = interaction.options.getUser('user', true);
        const remove = interaction.options.getBoolean('remove') ?? false;
        const reason = interaction.options.getString('reason') ?? undefined;

        if (remove) await removeFromBlacklist('user', user.id);
        else await addToBlacklist('user', user.id, reason);

        await interaction.reply({
          content: `${remove ? 'Unblocked' : 'Blocked'} ${user.tag}.`,
          ephemeral: true,
        });
        return;
      }

      case 'resetkeys': {
        const keyId = interaction.options.getString('key_id') ?? undefined;
        ctx.pool.reset(keyId);
        await interaction.reply({
          content: `Reset ${keyId ?? 'all keys'} to healthy. Check \`/status\`.`,
          ephemeral: true,
        });
        return;
      }

      case 'prunecache': {
        await interaction.deferReply({ ephemeral: true });
        const { removed, freedBytes } = await ctx.cache.prune();
        await interaction.editReply({
          content: `Removed **${removed}** cached clips, freeing **${(freedBytes / 1_048_576).toFixed(1)} MB**.`,
        });
        return;
      }

      default: {
        const [settings, ignores] = await Promise.all([
          getGuild(guildId, interaction.guild.name),
          getIgnores(guildId),
        ]);

        await interaction.reply({
          components: [
            container({
              color: 'primary',
              sections: [
                '### Server configuration',
                [
                  `**Reading from** ${settings.tts_channel_id ? `<#${settings.tts_channel_id}>` : '_not set_'}`,
                  `**Read all messages** ${settings.read_all_messages ? 'yes' : 'no — /tts only'}`,
                  `**Announce speaker** ${settings.announce_speaker ? 'yes' : 'no'}`,
                  '',
                  `**Max characters** ${settings.max_message_chars}`,
                  `**Cooldown** ${settings.user_cooldown_ms}ms`,
                  `**Auto-leave** ${settings.auto_leave_seconds === 0 ? 'disabled' : `${settings.auto_leave_seconds}s`}`,
                  '',
                  `**Default voice** ${settings.default_speaker} · ${settings.default_emotion} · ${settings.default_locale}`,
                  `**Premium** ${settings.is_premium ? 'yes' : 'no'}`,
                ].join('\n'),
                [
                  '**Ignored**',
                  `Channels: ${ignores.channel.size} · Roles: ${ignores.role.size} · Users: ${ignores.user.size}`,
                ].join('\n'),
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
