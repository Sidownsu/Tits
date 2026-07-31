/**
 * Shared UI building blocks.
 *
 * A note on "Components V2": Discord's newer component system (IsComponentsV2
 * message flag, Container / Section / TextDisplay / Separator / MediaGallery)
 * is exposed in discord.js v14 as `ContainerBuilder` and friends. It replaces
 * embeds entirely on a message — a V2 message may not also carry embeds, and
 * content is expressed as TextDisplay components inside a Container.
 *
 * This module provides both styles: `container()` for V2 surfaces, and
 * `embed()` for the plain-embed paths, so callers can pick per message rather
 * than the codebase committing globally to one.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  type APIEmbedField,
} from 'discord.js';

/** Accent colours, tuned for legibility on Discord's dark theme. */
export const COLORS = {
  primary: 0x76b900, // NVIDIA green
  success: 0x43b581,
  warning: 0xfaa61a,
  danger: 0xf04747,
  neutral: 0x2f3136,
} as const;

export type ColorName = keyof typeof COLORS;

export function embed(options: {
  title?: string;
  description?: string;
  color?: ColorName;
  fields?: APIEmbedField[];
  footer?: string;
  thumbnail?: string;
}): EmbedBuilder {
  const e = new EmbedBuilder().setColor(COLORS[options.color ?? 'primary']);
  if (options.title) e.setTitle(options.title);
  if (options.description) e.setDescription(options.description);
  if (options.fields?.length) e.addFields(options.fields);
  if (options.footer) e.setFooter({ text: options.footer });
  if (options.thumbnail) e.setThumbnail(options.thumbnail);
  return e;
}

/**
 * Build a Components V2 container.
 *
 * Send with `flags: MessageFlags.IsComponentsV2` and no `embeds` / `content`.
 * Use {@link v2Flags} to get the right flag combination.
 */
export function container(options: {
  color?: ColorName;
  /** Markdown blocks, rendered as TextDisplay components in order. */
  sections: string[];
  /** Insert a divider between each section. */
  separators?: boolean;
}): ContainerBuilder {
  const c = new ContainerBuilder().setAccentColor(COLORS[options.color ?? 'primary']);

  options.sections.forEach((text, index) => {
    if (options.separators && index > 0) {
      c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Small));
    }
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  });

  return c;
}

/** Flags for a Components V2 message, optionally ephemeral. */
export function v2Flags(ephemeral = false): number {
  return ephemeral
    ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    : MessageFlags.IsComponentsV2;
}

export function button(options: {
  id: string;
  label: string;
  style?: keyof typeof ButtonStyle;
  emoji?: string;
  disabled?: boolean;
}): ButtonBuilder {
  const b = new ButtonBuilder()
    .setCustomId(options.id)
    .setLabel(options.label)
    .setStyle(ButtonStyle[options.style ?? 'Secondary']);
  if (options.emoji) b.setEmoji(options.emoji);
  if (options.disabled) b.setDisabled(true);
  return b;
}

export function buttonRow(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

export function selectRow(
  menu: StringSelectMenuBuilder,
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/**
 * Build a string select menu. Discord caps a menu at 25 options, so callers
 * with longer lists must paginate — `truncate` guards against a silent API
 * rejection when they forget.
 */
export function select(options: {
  id: string;
  placeholder: string;
  choices: Array<{ label: string; value: string; description?: string; default?: boolean }>;
  truncate?: boolean;
}): StringSelectMenuBuilder {
  const choices = options.truncate === false ? options.choices : options.choices.slice(0, 25);

  return new StringSelectMenuBuilder()
    .setCustomId(options.id)
    .setPlaceholder(options.placeholder)
    .addOptions(
      choices.map((c) => {
        const o = new StringSelectMenuOptionBuilder().setLabel(c.label).setValue(c.value);
        if (c.description) o.setDescription(c.description.slice(0, 100));
        if (c.default) o.setDefault(true);
        return o;
      }),
    );
}

/** Render a 0..1 ratio as a compact text meter. */
export function meter(ratio: number, width = 12): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
