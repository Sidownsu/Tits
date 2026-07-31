#!/usr/bin/env node
/**
 * Vendor NVIDIA's canonical Riva protos.
 *
 * The bot ships a hand-trimmed `src/nim/protos/riva_tts.proto` that covers the
 * RPCs it uses. That is enough to run, but if NVIDIA changes the schema the
 * upstream files are authoritative. Running this script clones them into
 * `src/nim/protos/vendor/`, which the loader prefers when present.
 *
 * Usage:  npm run fetch-protos
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(here, '..', 'src', 'nim', 'protos', 'vendor');
const REPO = 'https://github.com/nvidia-riva/common.git';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

try {
  run('git', ['--version'], { stdio: 'ignore' });
} catch {
  console.error('git is required to fetch protos. Install git and retry.');
  process.exit(1);
}

if (existsSync(vendorDir)) {
  console.log(`Removing existing ${vendorDir}`);
  rmSync(vendorDir, { recursive: true, force: true });
}

mkdirSync(vendorDir, { recursive: true });

console.log(`Cloning ${REPO} …`);
run('git', ['clone', '--depth', '1', REPO, join(vendorDir, 'common')]);

console.log('\nProtos vendored to src/nim/protos/vendor/common/riva/proto/');
console.log('The gRPC loader will now prefer these over the bundled trimmed copy.');
