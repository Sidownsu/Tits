/**
 * Entry point.
 *
 * Boot order matters: configuration is validated before anything is
 * constructed, the database and cache come up before the Discord client logs
 * in, and voice discovery runs once the NIM client exists but before the first
 * user can reach a command.
 */
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';

import { loadConfig } from './config/index.js';
import { createLogger, logger } from './utils/logger.js';
import { initDatabase } from './database/client.js';
import { loadBlacklist } from './database/repositories/ttsRepository.js';
import { buildContext } from './core/context.js';
import { onInteractionCreate } from './events/interactionCreate.js';
import { onMessageCreate } from './events/messageCreate.js';
import { clearVoiceTimers, onVoiceStateUpdate } from './events/voiceStateUpdate.js';
import { startJobs, stopJobs } from './jobs/maintenance.js';
import type { BotContext } from './core/context.js';

const log = createLogger('bot');

async function main(): Promise<void> {
  const config = loadConfig();

  log.info(
    {
      env: config.NODE_ENV,
      nimKeys: config.nimKeys.length,
      strategy: config.NIM_STRATEGY,
    },
    'Starting NIM TTS bot',
  );

  initDatabase(config);
  await loadBlacklist();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      // Required to read message text. Must also be enabled in the Developer
      // Portal, and requires verification once the bot passes 100 guilds.
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  const ctx: BotContext = await buildContext(client, config);

  // Ask the live service which voices exist. Best-effort; the seed catalogue
  // covers a failure here.
  await ctx.nim.discoverVoices();

  client.once(Events.ClientReady, (ready) => {
    log.info(
      { tag: ready.user.tag, guilds: ready.guilds.cache.size },
      'Connected to Discord',
    );
    ready.user.setActivity('/join to start');
    startJobs(ctx);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void onInteractionCreate(interaction, ctx);
  });

  client.on(Events.MessageCreate, (message) => {
    void onMessageCreate(message, ctx);
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    onVoiceStateUpdate(oldState, newState, ctx);
  });

  client.on(Events.Error, (err) => log.error({ err }, 'Discord client error'));
  client.on(Events.Warn, (message) => log.warn({ message }, 'Discord client warning'));

  // ── Shutdown ───────────────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal }, 'Shutting down');
    stopJobs();
    clearVoiceTimers();
    ctx.sessions.destroyAll();

    try {
      await client.destroy();
    } catch (err) {
      log.warn({ err }, 'Error while destroying Discord client');
    }

    // Give pino a moment to flush before the process exits.
    setTimeout(() => process.exit(0), 250).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception — exiting');
    void shutdown('uncaughtException');
  });

  await client.login(config.DISCORD_TOKEN);
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
