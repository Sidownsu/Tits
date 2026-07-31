/**
 * Register slash commands with Discord.
 *
 * Guild registration is instant and is what you want while developing; global
 * registration can take up to an hour to propagate. Set DEBUG_GUILD_ID to use
 * the fast path.
 *
 *   npm run deploy-commands
 */
import { REST, Routes } from 'discord.js';

import { loadConfig } from '../config/index.js';
import { commands } from '../commands/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('deploy');

async function main(): Promise<void> {
  const config = loadConfig();
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
  const body = commands.map((c) => c.data.toJSON());

  const route = config.DEBUG_GUILD_ID
    ? Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DEBUG_GUILD_ID)
    : Routes.applicationCommands(config.DISCORD_CLIENT_ID);

  log.info(
    { count: body.length, scope: config.DEBUG_GUILD_ID ? 'guild' : 'global' },
    'Registering commands',
  );

  await rest.put(route, { body });

  log.info(
    config.DEBUG_GUILD_ID
      ? 'Registered to the debug guild — available immediately.'
      : 'Registered globally — may take up to an hour to appear.',
  );
}

main().catch((err) => {
  log.fatal({ err }, 'Command registration failed');
  process.exit(1);
});
