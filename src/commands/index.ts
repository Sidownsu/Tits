/** Command registry — the single place a new command must be listed. */
import { admin } from './admin.js';
import { favorites, history } from './personal.js';
import { help } from './help.js';
import { join, leave } from './connection.js';
import { clear, pause, queue, resume, skip, stop } from './playback.js';
import { pronounce } from './pronounce.js';
import { settings } from './settings.js';
import { speak, tts } from './speak.js';
import { status } from './status.js';
import { voice } from './voice.js';
import type { Command } from './types.js';

export const commands: Command[] = [
  // Connection
  join,
  leave,
  // Speaking
  tts,
  speak,
  // Personalisation
  voice,
  settings,
  favorites,
  history,
  pronounce,
  // Playback
  queue,
  skip,
  pause,
  resume,
  stop,
  clear,
  // Meta
  status,
  help,
  admin,
];

export const commandMap = new Map<string, Command>(
  commands.map((c) => [c.data.name, c]),
);
