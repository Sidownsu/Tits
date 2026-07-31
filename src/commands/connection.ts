/** /join and /leave — voice channel connection management. */
import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type VoiceBasedChannel,
} from 'discord.js';

import { createLogger } from '../utils/logger.js';
import { getGuild, updateGuild } from '../database/repositories/guildRepository.js';
import { container, v2Flags } from '../ui/components.js';
import type { BotContext } from '../core/context.js';
import type { Command } from './types.js';

const log = createLogger('cmd:connection');

/**
 * Work out which channel to join: an explicit option, else the caller's current
 * channel. Returns a user-facing error string when neither is available.
 */
function targetChannel(
  interaction: ChatInputCommandInteraction,
): { channel: VoiceBasedChannel } | { error: string } {
  const explicit = interaction.options.getChannel('channel');
  if (explicit && 'guild' in explicit) {
    const ch = explicit as VoiceBasedChannel;
    if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) {
      return { error: 'That is not a voice channel.' };
    }
    return { channel: ch };
  }

  const member = interaction.member as GuildMember | null;
  const current = member?.voice?.channel ?? null;
  if (!current) {
    return {
      error: 'Join a voice channel first, or name one with the `channel` option.',
    };
  }
  return { channel: current };
}

export const join: Command = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Bring the bot into a voice channel and start reading chat')
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Voice channel to join (defaults to yours)')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
    )
    .addChannelOption((o) =>
      o
        .setName('read_from')
        .setDescription('Text channel to read aloud (defaults to this one)')
        .addChannelTypes(ChannelType.GuildText),
    ) as SlashCommandBuilder,

  async execute(interaction, ctx: BotContext) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
      return;
    }

    const target = targetChannel(interaction);
    if ('error' in target) {
      await interaction.reply({ content: target.error, ephemeral: true });
      return;
    }

    const { channel } = target;

    // Check permissions before attempting, so the failure message is useful.
    const me = interaction.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.Connect) || !perms.has(PermissionFlagsBits.Speak)) {
      await interaction.reply({
        content: `I need **Connect** and **Speak** permissions in ${channel.toString()}.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    const readFrom =
      interaction.options.getChannel('read_from')?.id ?? interaction.channelId;
    const guildSettings = await getGuild(interaction.guildId, interaction.guild.name);

    try {
      await ctx.sessions.join(channel, readFrom, {
        maxQueueSize: ctx.config.MAX_QUEUE_SIZE,
        autoLeaveSeconds: guildSettings.auto_leave_seconds,
      });

      // Remember the text channel so /join with no options works next time.
      if (guildSettings.tts_channel_id !== readFrom) {
        await updateGuild(interaction.guildId, { tts_channel_id: readFrom });
      }

      await interaction.editReply({
        components: [
          container({
            color: 'success',
            sections: [
              `### Connected to ${channel.toString()}`,
              [
                `Reading messages from <#${readFrom}>.`,
                '',
                'Type in that channel and I will speak it aloud.',
                'Use `/voice` to pick how you sound, `/leave` when you are done.',
              ].join('\n'),
            ],
            separators: true,
          }),
        ],
        flags: v2Flags(),
      });
    } catch (err) {
      log.error({ err, guildId: interaction.guildId }, '/join failed');
      await interaction.editReply({
        content:
          'I could not establish a voice connection. This is usually a transient Discord voice issue — try again in a moment.',
      });
    }
  },
};

export const leave: Command = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Disconnect the bot from voice and clear the queue'),

  async execute(interaction, ctx: BotContext) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
      return;
    }

    const session = ctx.sessions.get(interaction.guildId);
    if (!session) {
      await interaction.reply({ content: 'I am not in a voice channel here.', ephemeral: true });
      return;
    }

    const spoken = session.messagesSpoken;
    const dropped = session.queueLength;
    ctx.sessions.leave(interaction.guildId);

    await interaction.reply({
      components: [
        container({
          color: 'neutral',
          sections: [
            '### Disconnected',
            `Spoke **${spoken}** message${spoken === 1 ? '' : 's'} this session.` +
              (dropped > 0 ? `\nDiscarded **${dropped}** queued item${dropped === 1 ? '' : 's'}.` : ''),
          ],
          separators: true,
        }),
      ],
      flags: v2Flags(),
    });
  },
};
