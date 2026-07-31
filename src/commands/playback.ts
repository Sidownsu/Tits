/** Queue control: /skip, /pause, /resume, /stop, /clear, /queue. */
import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

import { container, formatDuration, v2Flags } from '../ui/components.js';
import type { BotContext } from '../core/context.js';
import type { Command } from './types.js';
import type { VoiceSession } from '../voice/session.js';

/** Fetch the guild session, replying with a helpful message when absent. */
async function requireSession(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<VoiceSession | null> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
    return null;
  }
  const session = ctx.sessions.get(interaction.guildId);
  if (!session) {
    await interaction.reply({
      content: 'I am not in a voice channel — run `/join` first.',
      ephemeral: true,
    });
    return null;
  }
  return session;
}

/**
 * Moderators may control anyone's playback; ordinary users may only skip or
 * clear their own items. Prevents one person silencing a whole channel.
 */
function isModerator(interaction: ChatInputCommandInteraction): boolean {
  return (
    interaction.inCachedGuild() &&
    Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages))
  );
}

export const skip: Command = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip whatever is currently being spoken'),

  async execute(interaction, ctx) {
    const session = await requireSession(interaction, ctx);
    if (!session) return;

    const current = session.nowPlaying;
    if (!current) {
      await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
      return;
    }

    if (current.userId !== interaction.user.id && !isModerator(interaction)) {
      await interaction.reply({
        content: 'You can only skip your own messages.',
        ephemeral: true,
      });
      return;
    }

    session.skip();
    await interaction.reply({ content: 'Skipped.', ephemeral: true });
  },
};

export const pause: Command = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),

  async execute(interaction, ctx) {
    const session = await requireSession(interaction, ctx);
    if (!session) return;

    if (!isModerator(interaction)) {
      await interaction.reply({
        content: 'Pausing affects everyone, so it needs the Manage Messages permission.',
        ephemeral: true,
      });
      return;
    }

    const ok = session.pause();
    await interaction.reply({
      content: ok ? 'Paused. Use `/resume` to continue.' : 'Already paused.',
      ephemeral: true,
    });
  },
};

export const resume: Command = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),

  async execute(interaction, ctx) {
    const session = await requireSession(interaction, ctx);
    if (!session) return;

    if (!isModerator(interaction)) {
      await interaction.reply({
        content: 'Resuming affects everyone, so it needs the Manage Messages permission.',
        ephemeral: true,
      });
      return;
    }

    const ok = session.resume();
    await interaction.reply({
      content: ok ? 'Resumed.' : 'Not paused.',
      ephemeral: true,
    });
  },
};

export const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and empty the queue'),

  async execute(interaction, ctx) {
    const session = await requireSession(interaction, ctx);
    if (!session) return;

    if (!isModerator(interaction)) {
      await interaction.reply({
        content: 'Stopping affects everyone, so it needs the Manage Messages permission.',
        ephemeral: true,
      });
      return;
    }

    const dropped = session.queueLength;
    session.stop();
    await interaction.reply({
      content: `Stopped and cleared **${dropped}** queued item${dropped === 1 ? '' : 's'}.`,
      ephemeral: true,
    });
  },
};

export const clear: Command = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Remove queued messages')
    .addUserOption((o) =>
      o
        .setName('user')
        .setDescription("Clear only this user's messages (moderators only)"),
    ) as SlashCommandBuilder,

  async execute(interaction, ctx) {
    const session = await requireSession(interaction, ctx);
    if (!session) return;

    const target = interaction.options.getUser('user');

    if (target && target.id !== interaction.user.id && !isModerator(interaction)) {
      await interaction.reply({
        content: "Clearing another user's messages needs the Manage Messages permission.",
        ephemeral: true,
      });
      return;
    }

    // With no target, ordinary users clear their own items; moderators clear all.
    let removed: number;
    if (target) {
      removed = session.clearUser(target.id);
    } else if (isModerator(interaction)) {
      removed = session.clearQueue();
    } else {
      removed = session.clearUser(interaction.user.id);
    }

    await interaction.reply({
      content: `Removed **${removed}** item${removed === 1 ? '' : 's'} from the queue.`,
      ephemeral: true,
    });
  },
};

export const queue: Command = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show what is waiting to be spoken'),

  async execute(interaction, ctx) {
    const session = await requireSession(interaction, ctx);
    if (!session) return;

    const items = session.snapshot();
    const current = session.nowPlaying;

    const lines: string[] = [];
    if (current) {
      lines.push(`**Now** <@${current.userId}> — ${current.preview}`);
    } else {
      lines.push('_Nothing playing._');
    }

    if (items.length > 0) {
      lines.push('');
      lines.push(
        ...items
          .slice(0, 10)
          .map(
            (item, i) =>
              `\`${String(i + 1).padStart(2)}\` ${item.priority ? '⚡ ' : ''}<@${item.userId}> — ${item.preview}`,
          ),
      );
      if (items.length > 10) {
        lines.push(`-# …and ${items.length - 10} more`);
      }
    }

    const ping = session.pingMs;

    await interaction.reply({
      components: [
        container({
          color: session.isPaused ? 'warning' : 'primary',
          sections: [
            `### Queue — ${items.length} waiting${session.isPaused ? ' (paused)' : ''}`,
            lines.join('\n'),
            `-# Session up ${formatDuration(Date.now() - session.startedAt)} · ` +
              `${session.messagesSpoken} spoken` +
              (ping !== null ? ` · ${ping}ms voice ping` : ''),
          ],
          separators: true,
        }),
      ],
      flags: v2Flags(true),
    });
  },
};
