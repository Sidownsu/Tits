/**
 * Audio post-processing.
 *
 * Magpie returns 22.05 kHz mono 16-bit PCM. Discord wants 48 kHz stereo Opus.
 * ffmpeg bridges the two and, in the same pass, applies the speed / pitch /
 * volume shaping and loudness normalisation that the model itself does not
 * expose as parameters.
 *
 * Everything happens in one ffmpeg invocation rather than a chain of them —
 * each extra process spawn would add tens of milliseconds to time-to-first-word.
 */
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import ffmpegPath from 'ffmpeg-static';

import { createLogger } from '../utils/logger.js';

const log = createLogger('voice:audio');

export interface AudioShaping {
  /** 0.5–2.0. Implemented with atempo, which preserves pitch. */
  speed: number;
  /** −12…+12 semitones. Implemented by resampling + atempo compensation. */
  pitchSemitones: number;
  /** 0.0–2.0 linear gain. */
  volume: number;
  /** Trim leading/trailing silence and normalise loudness. */
  normalize: boolean;
}

export const DEFAULT_SHAPING: AudioShaping = {
  speed: 1,
  pitchSemitones: 0,
  volume: 1,
  normalize: true,
};

/**
 * atempo only accepts 0.5–2.0 per instance, so larger changes are expressed as
 * a chain of stages whose product is the requested factor.
 */
function atempoChain(factor: number): string[] {
  const stages: string[] = [];
  let remaining = factor;

  while (remaining > 2.0) {
    stages.push('atempo=2.0');
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    stages.push('atempo=0.5');
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 0.001) {
    stages.push(`atempo=${remaining.toFixed(4)}`);
  }
  return stages;
}

/**
 * Build the ffmpeg filter graph for the requested shaping.
 *
 * Pitch shifting works by lying to ffmpeg about the sample rate (which moves
 * pitch and tempo together) and then undoing the tempo change with atempo,
 * leaving only the pitch shift.
 */
export function buildFilterGraph(shaping: AudioShaping, inputRate: number): string {
  const filters: string[] = [];

  const pitchFactor = 2 ** (shaping.pitchSemitones / 12);

  if (Math.abs(shaping.pitchSemitones) > 0) {
    filters.push(`asetrate=${Math.round(inputRate * pitchFactor)}`);
    filters.push(`aresample=${inputRate}`);
    // Compensate the tempo change the resample introduced.
    filters.push(...atempoChain(1 / pitchFactor));
  }

  if (Math.abs(shaping.speed - 1) > 0.001) {
    filters.push(...atempoChain(shaping.speed));
  }

  if (shaping.normalize) {
    // Strip silence at both ends, then even out loudness so one user's voice is
    // not dramatically louder than another's.
    filters.push(
      'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05:detection=peak',
      'areverse',
      'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05:detection=peak',
      'areverse',
      'loudnorm=I=-16:TP=-1.5:LRA=11',
    );
  }

  if (Math.abs(shaping.volume - 1) > 0.001) {
    filters.push(`volume=${shaping.volume.toFixed(2)}`);
  }

  return filters.join(',');
}

/**
 * Convert raw PCM from NIM into a 48 kHz stereo PCM stream ready for
 * @discordjs/voice, applying the requested shaping.
 *
 * Returns a stream rather than a buffer so playback can begin before the whole
 * clip has been transcoded.
 */
export function processAudio(
  pcm: Buffer,
  inputRate: number,
  shaping: AudioShaping = DEFAULT_SHAPING,
): Readable {
  if (!ffmpegPath) {
    throw new Error('ffmpeg binary not found — is ffmpeg-static installed?');
  }

  const filterGraph = buildFilterGraph(shaping, inputRate);

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    // Input: raw signed 16-bit little-endian PCM, mono, at the model's rate.
    '-f', 's16le',
    '-ar', String(inputRate),
    '-ac', '1',
    '-i', 'pipe:0',
    ...(filterGraph ? ['-af', filterGraph] : []),
    // Output: what @discordjs/voice's StreamType.Raw expects.
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ];

  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  proc.stderr.on('data', (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) log.debug({ ffmpeg: msg }, 'ffmpeg stderr');
  });

  proc.on('error', (err) => {
    log.error({ err }, 'ffmpeg process error');
    proc.stdout.destroy(err);
  });

  // A broken pipe here just means playback was skipped; do not crash the bot.
  proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') log.warn({ err }, 'ffmpeg stdin error');
  });

  proc.stdin.end(pcm);
  return proc.stdout;
}

/** Rough playback duration of raw PCM, for queue time estimates. */
export function estimateDurationMs(
  pcmByteLength: number,
  sampleRate: number,
  channels = 1,
  bytesPerSample = 2,
): number {
  const frames = pcmByteLength / (channels * bytesPerSample);
  return Math.round((frames / sampleRate) * 1000);
}
