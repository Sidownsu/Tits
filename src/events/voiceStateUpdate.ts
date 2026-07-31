/**
 * Voice state tracking.
 *
 * Two jobs: leave when the channel empties out (nobody is listening, so holding
 * the connection wastes a voice slot), and follow along when a moderator drags
 * the bot to a different channel rather than treating it as a disconnect.
 */
import type { Guild, VoiceState } from 'discord.js';

import { createLogger } from '../utils/logger.js';
import type { BotContext } from '../core/context.js';

const log = createLogger('event:voice');

/**
 * Count non-bot members in a voice channel.
 *
 * `guild.channels.cache.get()` can return a thread, whose `members` is a
 * manager rather than a collection — narrowing with `isVoiceBased()` keeps this
 * honest instead of casting the difference away.
 */
function humanCount(guild: Guild, channelId: string): number {
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isVoiceBased()) return 0;
  return channel.members.filter((m) => !m.user.bot).size;
}

/** Grace period before leaving an empty channel, so a brief exit does not evict us. */
const EMPTY_CHANNEL_GRACE_MS = 15_000;

const pendingLeaves = new Map<string, NodeJS.Timeout>();

export function onVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  ctx: BotContext,
): void {
  const guildId = newState.guild.id;
  const session = ctx.sessions.get(guildId);
  if (!session) return;

  const botId = ctx.client.user?.id;

  // The bot itself was moved or disconnected.
  if (newState.member?.id === botId) {
    if (!newState.channelId) {
      log.info({ guildId }, 'Bot was disconnected from voice');
      ctx.sessions.leave(guildId);
      return;
    }
    if (newState.channelId !== session.voiceChannelId) {
      log.info(
        { guildId, from: session.voiceChannelId, to: newState.channelId },
        'Bot was moved to a different voice channel',
      );
      session.voiceChannelId = newState.channelId;
    }
    return;
  }

  // Somebody else changed state — only care about our own channel.
  const affectsUs =
    oldState.channelId === session.voiceChannelId ||
    newState.channelId === session.voiceChannelId;
  if (!affectsUs) return;

  const humans = humanCount(newState.guild, session.voiceChannelId);
  const pending = pendingLeaves.get(guildId);

  if (humans === 0) {
    if (pending) return; // Already counting down.
    const timer = setTimeout(() => {
      pendingLeaves.delete(guildId);
      const live = ctx.sessions.get(guildId);
      if (!live) return;

      if (humanCount(newState.guild, live.voiceChannelId) === 0) {
        log.info({ guildId }, 'Voice channel empty; leaving');
        ctx.sessions.leave(guildId);
      }
    }, EMPTY_CHANNEL_GRACE_MS);

    pendingLeaves.set(guildId, timer);
    return;
  }

  // Someone came back — cancel any pending departure.
  if (pending) {
    clearTimeout(pending);
    pendingLeaves.delete(guildId);
  }
}

/** Clear timers on shutdown so the process can exit cleanly. */
export function clearVoiceTimers(): void {
  for (const timer of pendingLeaves.values()) clearTimeout(timer);
  pendingLeaves.clear();
}
