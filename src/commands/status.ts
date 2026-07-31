/**
 * /status — live diagnostics.
 *
 * The single most useful command when the bot misbehaves: it shows exactly
 * which NIM keys are healthy, cooling or circuit-open, plus cache and database
 * health. Key *ids* are shown; the secrets never are.
 */
import { SlashCommandBuilder, version as djsVersion } from 'discord.js';

import { pingDatabase } from '../database/client.js';
import { isDiscovered, allVoices, localesAvailable } from '../nim/voices.js';
import { container, formatDuration, meter, v2Flags } from '../ui/components.js';
import type { KeyStats } from '../nim/types.js';
import type { BotContext } from '../core/context.js';
import type { Command } from './types.js';

const STATE_ICON: Record<KeyStats['state'], string> = {
  healthy: '🟢',
  cooling: '🟡',
  open: '🔴',
  disabled: '⚫',
};

function renderKey(k: KeyStats): string {
  const parts = [`${STATE_ICON[k.state]} \`${k.id}\``];

  if (k.requests === 0) {
    parts.push('_unused_');
  } else {
    parts.push(
      `${k.requests} req · ${Math.round(k.successRate * 100)}% ok · ${k.avgLatencyMs}ms avg`,
    );
  }

  if (k.inFlight > 0) parts.push(`${k.inFlight} in flight`);

  if (k.state === 'cooling' && k.cooldownUntil) {
    const remaining = Math.max(0, k.cooldownUntil - Date.now());
    parts.push(`cooling ${Math.ceil(remaining / 1000)}s`);
  }
  if (k.state === 'disabled') parts.push('**rejected by NVIDIA**');
  if (k.state === 'open') parts.push('**circuit open**');

  const line = parts.join(' · ');
  return k.lastError && k.state !== 'healthy'
    ? `${line}\n-# ${k.lastError.slice(0, 120)}`
    : line;
}

export const status: Command = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show API key health, cache and connection diagnostics'),

  async execute(interaction, ctx: BotContext) {
    await interaction.deferReply({ ephemeral: true });

    const keys = ctx.pool.stats();
    const cache = ctx.cache.stats();
    const dbHealth = await pingDatabase();

    const totalRequests = keys.reduce((s, k) => s + k.requests, 0);
    const totalFailures = keys.reduce((s, k) => s + k.failures, 0);
    const healthy = keys.filter((k) => k.state === 'healthy').length;

    const overall: 'success' | 'warning' | 'danger' =
      healthy === 0 ? 'danger' : healthy < keys.length ? 'warning' : 'success';

    const voiceLine = isDiscovered()
      ? `${allVoices().length} voices across ${localesAvailable().length} locales (discovered)`
      : `${allVoices().length} voices (seed catalogue — live discovery unavailable)`;

    const sections = [
      `### Status — ${healthy}/${keys.length} keys healthy`,

      ['**NVIDIA NIM keys**', ...keys.map(renderKey)].join('\n'),

      [
        '**Traffic**',
        `${totalRequests} requests · ${totalFailures} failures` +
          (totalRequests > 0
            ? ` · ${Math.round(((totalRequests - totalFailures) / totalRequests) * 100)}% success`
            : ''),
        `Strategy \`${ctx.config.NIM_STRATEGY}\``,
      ].join('\n'),

      [
        '**Cache**',
        `\`${meter(cache.hitRate)}\` ${Math.round(cache.hitRate * 100)}% hit rate`,
        `${cache.hits} hits (${cache.memoryHits} memory / ${cache.diskHits} disk) · ${cache.misses} misses`,
        `${cache.memoryEntries} entries in memory · ${cache.evictions} evicted`,
      ].join('\n'),

      [
        '**Infrastructure**',
        `Supabase ${dbHealth.ok ? `🟢 ${dbHealth.latencyMs}ms` : `🔴 ${dbHealth.error ?? 'unreachable'}`}`,
        `Discord gateway ${Math.round(ctx.client.ws.ping)}ms`,
        `Active voice sessions ${ctx.sessions.size}`,
        voiceLine,
      ].join('\n'),

      `-# Uptime ${formatDuration(Date.now() - ctx.startedAt)} · discord.js ${djsVersion} · node ${process.version}`,
    ];

    await interaction.editReply({
      components: [container({ color: overall, sections, separators: true })] as never,
      flags: v2Flags(true),
    });
  },
};
