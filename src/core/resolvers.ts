/**
 * Mention resolvers backed by discord.js caches.
 *
 * Cache-only by design: `messageCreate` runs on every message and must not make
 * a REST call to resolve a mention. An uncached entity degrades to a generic
 * word ("someone", "a role") rather than blocking synthesis.
 */
import type { Guild } from 'discord.js';

import type { MentionResolvers } from '../utils/text.js';

export function buildResolvers(guild: Guild | null): MentionResolvers {
  if (!guild) return {};

  return {
    user: (id) => guild.members.cache.get(id)?.displayName,
    role: (id) => guild.roles.cache.get(id)?.name,
    channel: (id) => guild.channels.cache.get(id)?.name,
  };
}
