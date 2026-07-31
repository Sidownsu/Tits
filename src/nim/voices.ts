/**
 * Magpie TTS voice catalogue.
 *
 * ⚠ Reality check, and why this file looks smaller than you might expect:
 *
 * The original product spec asked for 23 voice "personas" (Anime, Robot,
 * Podcast, Streamer, …) across 30 accents. Magpie TTS Multilingual does not
 * work that way and cannot produce that catalogue. What it actually exposes is:
 *
 *   • 12 locales  — EN-US, ES-US, FR-FR, DE-DE, ZH-CN, VI-VN, IT-IT, HI-IN,
 *                   JA-JP, KO-KR, AR-AR, PT-BR
 *   • 13 speakers — a fixed set of named voices, NOT available in every locale
 *   • 7 emotions  — Neutral, Calm, Happy, Sad, Angry, Fearful, PleasantSurprised
 *                   and only on *some* speaker/locale combinations
 *
 * So "voice style" here maps to Magpie's emotion axis, and "accent" maps to its
 * locale axis. There is no British, Australian, Irish, Scottish, Tamil, Telugu,
 * Bengali, Urdu, Russian, Turkish, Thai, Polish or Dutch voice to offer.
 *
 * Rather than hardcode a speaker/locale matrix I could not fully verify against
 * NVIDIA's support matrix, the seed table below contains only combinations that
 * are documented, and {@link reconcileCatalogue} replaces it at boot with what
 * the live service actually reports via `GetRivaSynthesisConfig`. The seed is a
 * cold-start fallback, not the source of truth.
 */
import { createLogger } from '../utils/logger.js';

const log = createLogger('nim:voices');

export const MODEL_PREFIX = 'Magpie-Multilingual';

/** Locales supported by Magpie TTS Multilingual. */
export const LOCALES = [
  'en-US',
  'es-US',
  'fr-FR',
  'de-DE',
  'zh-CN',
  'vi-VN',
  'it-IT',
  'hi-IN',
  'ja-JP',
  'ko-KR',
  'ar-AR',
  'pt-BR',
] as const;

export type Locale = (typeof LOCALES)[number];

/** Human-facing labels for the locale picker. */
export const LOCALE_LABELS: Record<Locale, string> = {
  'en-US': 'English (US)',
  'es-US': 'Spanish (US)',
  'fr-FR': 'French (France)',
  'de-DE': 'German (Germany)',
  'zh-CN': 'Mandarin (China)',
  'vi-VN': 'Vietnamese',
  'it-IT': 'Italian',
  'hi-IN': 'Hindi (India)',
  'ja-JP': 'Japanese',
  'ko-KR': 'Korean',
  'ar-AR': 'Arabic',
  'pt-BR': 'Portuguese (Brazil)',
};

/** Emotional styles Magpie Multilingual can render. */
export const EMOTIONS = [
  'Neutral',
  'Calm',
  'Happy',
  'Sad',
  'Angry',
  'Fearful',
  'PleasantSurprised',
] as const;

export type Emotion = (typeof EMOTIONS)[number];

export const EMOTION_LABELS: Record<Emotion, string> = {
  Neutral: 'Neutral',
  Calm: 'Calm',
  Happy: 'Happy',
  Sad: 'Sad',
  Angry: 'Angry',
  Fearful: 'Fearful',
  PleasantSurprised: 'Pleasantly Surprised',
};

export interface Voice {
  /** Full Riva voice name, e.g. `Magpie-Multilingual.EN-US.Mia.Calm`. */
  name: string;
  speaker: string;
  locale: Locale;
  emotion: Emotion;
}

/**
 * Documented speakers per locale.
 *
 * Only entries confirmed against NVIDIA's published docs are listed. Locales
 * mapped to an empty array are supported by the model but their speaker roster
 * was not verifiable at build time — they populate from runtime discovery.
 */
const SEED_SPEAKERS: Record<Locale, string[]> = {
  'en-US': ['Mia', 'Jason', 'Aria'],
  'es-US': [],
  'fr-FR': [],
  'de-DE': [],
  'zh-CN': [],
  'vi-VN': [],
  'it-IT': [],
  'hi-IN': [],
  'ja-JP': [],
  'ko-KR': [],
  'ar-AR': [],
  'pt-BR': [],
};

/** All speaker names Magpie is documented to ship, across all locales. */
export const KNOWN_SPEAKERS = [
  'Aria',
  'Diego',
  'HouZhen',
  'Isabela',
  'Jason',
  'Leo',
  'Long',
  'Louise',
  'Mia',
  'Pascal',
  'Ray',
  'Siwei',
  'Sofia',
] as const;

/** Live catalogue, seeded then replaced by runtime discovery. */
let catalogue: Voice[] = buildSeedCatalogue();
let discovered = false;

function buildSeedCatalogue(): Voice[] {
  const out: Voice[] = [];
  for (const locale of LOCALES) {
    for (const speaker of SEED_SPEAKERS[locale]) {
      for (const emotion of EMOTIONS) {
        out.push({
          name: voiceName(speaker, locale, emotion),
          speaker,
          locale,
          emotion,
        });
      }
    }
  }
  return out;
}

/** Compose a Riva voice name. Locale segment is upper-cased, as Riva expects. */
export function voiceName(speaker: string, locale: Locale, emotion: Emotion): string {
  return `${MODEL_PREFIX}.${locale.toUpperCase()}.${speaker}.${emotion}`;
}

/** Parse a Riva voice name back into its parts, or null if malformed. */
export function parseVoiceName(name: string): Voice | null {
  const parts = name.split('.');
  if (parts.length < 3) return null;
  const [, localeRaw, speaker, emotionRaw] = parts;
  if (!localeRaw || !speaker) return null;

  const locale = LOCALES.find((l) => l.toUpperCase() === localeRaw.toUpperCase());
  if (!locale) return null;

  const emotion =
    EMOTIONS.find((e) => e.toLowerCase() === (emotionRaw ?? '').toLowerCase()) ??
    'Neutral';

  return { name, speaker, locale, emotion };
}

/**
 * Replace the seed catalogue with voices reported by the live service.
 * Called once at boot; falls back to the seed if discovery fails.
 */
export function reconcileCatalogue(voiceNames: string[]): void {
  const parsed = voiceNames
    .map(parseVoiceName)
    .filter((v): v is Voice => v !== null);

  if (parsed.length === 0) {
    log.warn('Voice discovery returned nothing usable; keeping seed catalogue');
    return;
  }

  catalogue = parsed;
  discovered = true;
  log.info(
    { voiceCount: parsed.length, localeCount: new Set(parsed.map((v) => v.locale)).size },
    'Voice catalogue reconciled from live service',
  );
}

export function isDiscovered(): boolean {
  return discovered;
}

export function allVoices(): readonly Voice[] {
  return catalogue;
}

export function localesAvailable(): Locale[] {
  return [...new Set(catalogue.map((v) => v.locale))].sort();
}

export function speakersFor(locale: Locale): string[] {
  return [...new Set(catalogue.filter((v) => v.locale === locale).map((v) => v.speaker))].sort();
}

export function emotionsFor(locale: Locale, speaker: string): Emotion[] {
  return [
    ...new Set(
      catalogue
        .filter((v) => v.locale === locale && v.speaker === speaker)
        .map((v) => v.emotion),
    ),
  ];
}

/**
 * Resolve a user's preferences to a concrete, existing voice.
 *
 * Degrades gracefully rather than failing: an unavailable emotion falls back to
 * Neutral for that speaker, an unavailable speaker falls back to the first
 * speaker in the locale, and an unavailable locale falls back to en-US. The bot
 * should always be able to say something.
 */
export function resolveVoice(
  locale: string,
  speaker: string,
  emotion: string,
): Voice {
  const exact = catalogue.find(
    (v) =>
      v.locale === locale &&
      v.speaker.toLowerCase() === speaker.toLowerCase() &&
      v.emotion.toLowerCase() === emotion.toLowerCase(),
  );
  if (exact) return exact;

  const sameSpeaker = catalogue.find(
    (v) => v.locale === locale && v.speaker.toLowerCase() === speaker.toLowerCase(),
  );
  if (sameSpeaker) return sameSpeaker;

  const sameLocale = catalogue.find((v) => v.locale === locale);
  if (sameLocale) return sameLocale;

  const fallback = catalogue.find((v) => v.locale === 'en-US') ?? catalogue[0];
  if (!fallback) {
    throw new Error('Voice catalogue is empty — cannot resolve any voice.');
  }
  return fallback;
}

export const DEFAULT_LOCALE: Locale = 'en-US';
export const DEFAULT_SPEAKER = 'Mia';
export const DEFAULT_EMOTION: Emotion = 'Neutral';
