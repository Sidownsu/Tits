/**
 * Turning a Discord message into something worth speaking aloud.
 *
 * Discord text is full of things that sound terrible when read literally:
 * raw snowflake mentions, custom emoji tags, code blocks, tracking-laden URLs,
 * markdown scaffolding. This module normalises all of it before synthesis.
 */

/** Resolvers the caller supplies so mentions can be spoken as names. */
export interface MentionResolvers {
  user?: (id: string) => string | undefined;
  role?: (id: string) => string | undefined;
  channel?: (id: string) => string | undefined;
}

export interface SanitizeOptions {
  /** Speak URLs as a short placeholder instead of reading the whole address. */
  readUrls?: boolean;
  /** Speak custom emoji by name (`:smile:` → "smile"). */
  readEmoji?: boolean;
  /** Per-user pronunciation overrides, applied last. */
  pronunciations?: Map<string, string>;
  resolvers?: MentionResolvers;
  /** Hard cap on the returned string. */
  maxLength?: number;
}

const DEFAULTS: Required<Omit<SanitizeOptions, 'pronunciations' | 'resolvers'>> = {
  readUrls: false,
  readEmoji: true,
  maxLength: 500,
};

/** Escape a string for safe inclusion in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip markdown formatting while keeping the words intact.
 * Handles code blocks, inline code, bold/italic/underline/strike, headers,
 * blockquotes, spoilers and masked links.
 */
export function stripMarkdown(input: string): string {
  return (
    input
      // Fenced code blocks — announce rather than read the code.
      .replace(/```[\s\S]*?```/g, ' code block ')
      // Inline code — keep the contents, drop the backticks.
      .replace(/`([^`]+)`/g, '$1')
      // Masked links [label](url) — speak the label only.
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Spoilers.
      .replace(/\|\|([^|]+)\|\|/g, '$1')
      // Bold / italic / underline / strikethrough.
      .replace(/(\*\*\*|\*\*|\*|___|__|_|~~)/g, '')
      // Headers and blockquotes at line start.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      // List bullets.
      .replace(/^\s*[-*+]\s+/gm, '')
  );
}

/** Replace mentions with readable names using caller-supplied resolvers. */
export function resolveMentions(input: string, resolvers: MentionResolvers = {}): string {
  return input
    .replace(/<@!?(\d+)>/g, (_m, id: string) => {
      const name = resolvers.user?.(id);
      return name ? ` ${name} ` : ' someone ';
    })
    .replace(/<@&(\d+)>/g, (_m, id: string) => {
      const name = resolvers.role?.(id);
      return name ? ` ${name} ` : ' a role ';
    })
    .replace(/<#(\d+)>/g, (_m, id: string) => {
      const name = resolvers.channel?.(id);
      return name ? ` ${name} ` : ' a channel ';
    })
    .replace(/@everyone/g, ' everyone ')
    .replace(/@here/g, ' here ');
}

/** Custom emoji `<:name:id>` / `<a:name:id>` → the name, or nothing. */
export function handleEmoji(input: string, read: boolean): string {
  return input.replace(/<a?:(\w+):\d+>/g, (_m, name: string) =>
    read ? ` ${name.replace(/_/g, ' ')} ` : ' ',
  );
}

const URL_RE = /https?:\/\/\S+/gi;

/** Replace URLs with a short spoken placeholder, or the bare hostname. */
export function handleUrls(input: string, read: boolean): string {
  return input.replace(URL_RE, (url) => {
    if (!read) return ' link ';
    try {
      return ` link to ${new URL(url).hostname.replace(/^www\./, '')} `;
    } catch {
      return ' link ';
    }
  });
}

/**
 * Apply pronunciation overrides as whole-word, case-insensitive replacements.
 * Longest keys first so multi-word entries win over their own substrings.
 */
export function applyPronunciations(
  input: string,
  dictionary: Map<string, string>,
): string {
  if (dictionary.size === 0) return input;

  const entries = [...dictionary.entries()].sort((a, b) => b[0].length - a[0].length);
  let out = input;
  for (const [from, to] of entries) {
    if (!from.trim()) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, 'gi'), to);
  }
  return out;
}

/** Collapse repeated characters that make TTS stutter ("!!!!!" → "!!"). */
export function collapseRepeats(input: string): string {
  return input.replace(/(.)\1{3,}/g, '$1$1');
}

/**
 * Full sanitisation pipeline. Order matters:
 *
 *  1. Mentions and emoji first. Their `<…>` tags contain characters markdown
 *     stripping would eat — `<:big_smile:123>` would lose its underscore to the
 *     italic rule and come out as "bigsmile".
 *  2. Markdown next, which also resolves `[label](url)` down to the label.
 *  3. URLs after markdown, so only bare links remain to be handled.
 *  4. Pronunciations last, so overrides apply to the final spoken words,
 *     including names substituted in for mentions.
 */
export function sanitize(input: string, options: SanitizeOptions = {}): string {
  const opts = { ...DEFAULTS, ...options };

  let out = input;
  out = resolveMentions(out, options.resolvers ?? {});
  out = handleEmoji(out, opts.readEmoji);
  out = stripMarkdown(out);
  out = handleUrls(out, opts.readUrls);
  out = collapseRepeats(out);
  out = applyPronunciations(out, options.pronunciations ?? new Map());

  // Normalise whitespace last so earlier substitutions cannot leave doubles.
  out = out.replace(/\s+/g, ' ').trim();

  if (out.length > opts.maxLength) {
    out = `${out.slice(0, opts.maxLength).trimEnd()}…`;
  }
  return out;
}

/**
 * Split text into chunks that each synthesize comfortably within the model's
 * per-request audio ceiling (Magpie caps output at ~20 seconds).
 *
 * Splits on sentence boundaries where possible, falling back to word boundaries
 * for run-on text and hard slicing only for a single oversized token.
 */
export function chunkForSynthesis(input: string, maxChars = 220): string[] {
  const text = input.trim();
  if (text.length === 0) return [];
  if (text.length <= maxChars) return [text];

  const sentences = text.match(/[^.!?…]+[.!?…]+[\s]*|[^.!?…]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = '';
  };

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      pushCurrent();
      // Sentence alone is too long — break it on words.
      let buffer = '';
      for (const word of sentence.split(/\s+/)) {
        if (word.length > maxChars) {
          if (buffer.trim()) chunks.push(buffer.trim());
          buffer = '';
          for (let i = 0; i < word.length; i += maxChars) {
            chunks.push(word.slice(i, i + maxChars));
          }
          continue;
        }
        if (`${buffer} ${word}`.trim().length > maxChars) {
          if (buffer.trim()) chunks.push(buffer.trim());
          buffer = word;
        } else {
          buffer = buffer ? `${buffer} ${word}` : word;
        }
      }
      if (buffer.trim()) chunks.push(buffer.trim());
      continue;
    }

    if ((current + sentence).length > maxChars) {
      pushCurrent();
    }
    current += sentence;
  }
  pushCurrent();

  return chunks.filter((c) => c.length > 0);
}
