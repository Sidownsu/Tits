/**
 * A voice session: the bot's presence in one guild's voice channel.
 *
 * Owns the connection, the playback queue and the idle timer. One session per
 * guild — Discord only permits one voice connection per guild anyway, so the
 * manager keys sessions by guild id.
 *
 * Queue semantics
 * ───────────────
 * Two priority bands rather than a full priority queue: premium/command items
 * jump ahead of ordinary chat messages, but ordering within a band is strictly
 * FIFO so a busy channel still sounds chronological.
 */
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';

import { createLogger } from '../utils/logger.js';
import { processAudio, type AudioShaping } from './audio.js';

const log = createLogger('voice:session');

export interface QueueItem {
  id: string;
  userId: string;
  /** Raw PCM from the synthesis stage. */
  pcm: Buffer;
  sampleRateHz: number;
  shaping: AudioShaping;
  /** Text kept for /queue display. */
  preview: string;
  priority: boolean;
  enqueuedAt: number;
}

export interface SessionOptions {
  maxQueueSize: number;
  /** Seconds of inactivity before the bot leaves. 0 disables auto-leave. */
  autoLeaveSeconds: number;
}

export class QueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`Queue is full (${limit} items).`);
    this.name = 'QueueFullError';
  }
}

export class VoiceSession {
  private connection: VoiceConnection;
  private readonly player: AudioPlayer;

  /** Two bands; `priority` drains before `normal`. */
  private readonly priorityQueue: QueueItem[] = [];
  private readonly normalQueue: QueueItem[] = [];

  private current: QueueItem | null = null;
  private paused = false;
  private destroyed = false;
  private idleTimer: NodeJS.Timeout | null = null;

  messagesSpoken = 0;
  readonly startedAt = Date.now();

  constructor(
    readonly guildId: string,
    public voiceChannelId: string,
    public textChannelId: string | null,
    channel: VoiceBasedChannel,
    private readonly options: SessionOptions,
    private readonly onDestroy: (guildId: string) => void,
  ) {
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.player = createAudioPlayer({
      behaviors: {
        // Keep the queue draining even if everyone leaves; the alternative is a
        // stuck player that never advances.
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    this.connection.subscribe(this.player);
    this.attachHandlers();
    this.resetIdleTimer();
  }

  private attachHandlers(): void {
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.current = null;
      void this.drain();
    });

    this.player.on('error', (err) => {
      log.error({ err, guildId: this.guildId }, 'Audio player error; skipping item');
      this.current = null;
      void this.drain();
    });

    // Discord moves voice servers around; a disconnect is usually recoverable.
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        log.info({ guildId: this.guildId }, 'Voice connection recovering');
      } catch {
        log.info({ guildId: this.guildId }, 'Voice connection lost; destroying session');
        this.destroy();
      }
    });

    this.connection.on(VoiceConnectionStatus.Destroyed, () => this.destroy());
  }

  /** Wait until the connection is usable, so the first clip is not dropped. */
  async waitUntilReady(timeoutMs = 20_000): Promise<void> {
    await entersState(this.connection, VoiceConnectionStatus.Ready, timeoutMs);
  }

  get queueLength(): number {
    return this.priorityQueue.length + this.normalQueue.length;
  }

  get isPlaying(): boolean {
    return this.current !== null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get nowPlaying(): QueueItem | null {
    return this.current;
  }

  /** Queue contents in the order they will actually play. */
  snapshot(): QueueItem[] {
    return [...this.priorityQueue, ...this.normalQueue];
  }

  enqueue(item: QueueItem): number {
    if (this.destroyed) throw new Error('Session has been destroyed.');
    if (this.queueLength >= this.options.maxQueueSize) {
      throw new QueueFullError(this.options.maxQueueSize);
    }

    (item.priority ? this.priorityQueue : this.normalQueue).push(item);
    this.resetIdleTimer();
    void this.drain();
    return this.queueLength;
  }

  /** Start the next item if the player is free. */
  private async drain(): Promise<void> {
    if (this.destroyed || this.paused || this.current) return;

    const next = this.priorityQueue.shift() ?? this.normalQueue.shift();
    if (!next) {
      this.resetIdleTimer();
      return;
    }

    this.current = next;

    try {
      const stream = processAudio(next.pcm, next.sampleRateHz, next.shaping);
      const resource = createAudioResource(stream, {
        inputType: StreamType.Raw,
        inlineVolume: false,
      });
      this.player.play(resource);
      this.messagesSpoken += 1;
      this.resetIdleTimer();
    } catch (err) {
      log.error({ err, guildId: this.guildId }, 'Failed to start playback; skipping');
      this.current = null;
      void this.drain();
    }
  }

  skip(): boolean {
    if (!this.current) return false;
    // Stopping fires Idle, which drains the next item.
    this.player.stop(true);
    return true;
  }

  pause(): boolean {
    if (this.paused) return false;
    this.paused = true;
    return this.player.pause(true);
  }

  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    const ok = this.player.unpause();
    void this.drain();
    return ok;
  }

  /** Stop playback and discard everything queued. */
  stop(): void {
    this.clearQueue();
    this.player.stop(true);
    this.current = null;
  }

  clearQueue(): number {
    const removed = this.queueLength;
    this.priorityQueue.length = 0;
    this.normalQueue.length = 0;
    return removed;
  }

  /** Drop every queued item belonging to one user (moderation escape hatch). */
  clearUser(userId: string): number {
    let removed = 0;
    for (const queue of [this.priorityQueue, this.normalQueue]) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i]?.userId === userId) {
          queue.splice(i, 1);
          removed += 1;
        }
      }
    }
    return removed;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.options.autoLeaveSeconds <= 0 || this.destroyed) return;

    this.idleTimer = setTimeout(() => {
      if (this.queueLength === 0 && !this.current) {
        log.info({ guildId: this.guildId }, 'Idle timeout reached; leaving voice');
        this.destroy();
      } else {
        this.resetIdleTimer();
      }
    }, this.options.autoLeaveSeconds * 1000);
  }

  /** Latency to Discord's voice websocket, or null when unavailable. */
  get pingMs(): number | null {
    const ping = this.connection.ping.ws;
    return typeof ping === 'number' && ping >= 0 ? ping : null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.clearQueue();
    this.current = null;

    try {
      this.player.stop(true);
    } catch {
      // Already stopped.
    }

    try {
      if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        this.connection.destroy();
      }
    } catch {
      // Already destroyed.
    }

    this.onDestroy(this.guildId);
    log.info({ guildId: this.guildId }, 'Voice session destroyed');
  }
}

/** Registry of live sessions, keyed by guild. */
export class SessionManager {
  private readonly sessions = new Map<string, VoiceSession>();

  get(guildId: string): VoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  has(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  get size(): number {
    return this.sessions.size;
  }

  all(): VoiceSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Join a channel, replacing any existing session in that guild.
   * Resolves once the connection is ready to accept audio.
   */
  async join(
    channel: VoiceBasedChannel,
    textChannelId: string | null,
    options: SessionOptions,
  ): Promise<VoiceSession> {
    this.sessions.get(channel.guild.id)?.destroy();

    const session = new VoiceSession(
      channel.guild.id,
      channel.id,
      textChannelId,
      channel,
      options,
      (guildId) => this.sessions.delete(guildId),
    );

    this.sessions.set(channel.guild.id, session);

    try {
      await session.waitUntilReady();
    } catch (err) {
      session.destroy();
      throw err;
    }

    return session;
  }

  leave(guildId: string): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    session.destroy();
    return true;
  }

  destroyAll(): void {
    for (const session of this.all()) session.destroy();
    this.sessions.clear();
  }
}
