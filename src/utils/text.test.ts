import { describe, expect, it } from 'vitest';

import { chunkForSynthesis, sanitize, stripMarkdown } from './text.js';

describe('stripMarkdown', () => {
  it('announces code blocks rather than reading them', () => {
    expect(stripMarkdown('look: ```js\nconst x = 1;\n```')).toContain('code block');
  });

  it('keeps the label from a masked link', () => {
    expect(stripMarkdown('[the docs](https://example.com)')).toBe('the docs');
  });

  it('removes emphasis without eating the words', () => {
    expect(stripMarkdown('**bold** and _italic_')).toBe('bold and italic');
  });
});

describe('sanitize', () => {
  it('resolves mentions through the supplied resolvers', () => {
    const out = sanitize('hey <@123> check <#456>', {
      resolvers: {
        user: (id) => (id === '123' ? 'Alice' : undefined),
        channel: (id) => (id === '456' ? 'general' : undefined),
      },
    });
    expect(out).toBe('hey Alice check general');
  });

  it('falls back to generic words for unresolvable mentions', () => {
    expect(sanitize('hi <@999>')).toBe('hi someone');
  });

  it('collapses URLs to a placeholder by default', () => {
    expect(sanitize('see https://example.com/x?y=1')).toBe('see link');
  });

  it('names the host when URL reading is enabled', () => {
    expect(sanitize('see https://example.com/x', { readUrls: true })).toBe(
      'see link to example.com',
    );
  });

  it('reads custom emoji by name', () => {
    expect(sanitize('nice <:big_smile:123>')).toBe('nice big smile');
  });

  it('applies pronunciations on whole words only', () => {
    const dict = new Map([['gif', 'jif']]);
    expect(sanitize('a gif and a gifted thing', { pronunciations: dict })).toBe(
      'a jif and a gifted thing',
    );
  });

  it('truncates past the maximum length', () => {
    // Deliberately non-repeating: collapseRepeats runs first and would shrink
    // a run of identical characters below the limit before truncation applied.
    const out = sanitize('abcdefghijklmnopqrstuvwxyz', { maxLength: 10 });
    expect(out.length).toBeLessThanOrEqual(11); // includes the ellipsis
    expect(out.endsWith('…')).toBe(true);
  });

  it('collapses spam repeats', () => {
    expect(sanitize('woooooow')).toBe('woow');
  });
});

describe('chunkForSynthesis', () => {
  it('leaves short text as a single chunk', () => {
    expect(chunkForSynthesis('Hello there.')).toEqual(['Hello there.']);
  });

  it('splits on sentence boundaries', () => {
    const text = `${'a'.repeat(150)}. ${'b'.repeat(150)}.`;
    const chunks = chunkForSynthesis(text, 200);
    expect(chunks.length).toBe(2);
  });

  it('breaks a run-on sentence on word boundaries', () => {
    const text = Array.from({ length: 100 }, () => 'word').join(' ');
    const chunks = chunkForSynthesis(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50);
  });

  it('hard-splits a single oversized token', () => {
    const chunks = chunkForSynthesis('x'.repeat(500), 100);
    expect(chunks.length).toBe(5);
  });

  it('returns nothing for empty input', () => {
    expect(chunkForSynthesis('   ')).toEqual([]);
  });
});
