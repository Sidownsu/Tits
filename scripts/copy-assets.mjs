#!/usr/bin/env node
/**
 * Copy non-TypeScript assets into dist/.
 *
 * `tsc` only emits .ts → .js, so the .proto files the gRPC client loads at
 * runtime never reach the build output on their own. Without this step a
 * production start (Docker, PM2 — anything running dist/index.js) dies at boot
 * with ENOENT on riva_tts.proto.
 */
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** [from, to] pairs, relative to the project root. */
const assets = [
  ['src/nim/protos', 'dist/nim/protos'],
];

for (const [from, to] of assets) {
  const source = join(root, from);
  if (!existsSync(source)) {
    console.warn(`skip: ${from} does not exist`);
    continue;
  }

  const destination = join(root, to);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
