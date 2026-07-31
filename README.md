# NIM TTS Bot

A Discord text-to-speech bot: users type in a text channel, the bot speaks it in
voice. Built for people who cannot or would rather not talk in VC.

TypeScript · discord.js v14 · NVIDIA NIM (Magpie TTS) over gRPC · Supabase

> **Read [NIM-LIMITATIONS.md](NIM-LIMITATIONS.md) first.** It documents what the
> NVIDIA model actually supports (12 locales, 13 speakers, 7 emotions — not 30
> accents and 23 personas) and the licensing boundary around the hosted
> endpoints. It will save you from designing around features that do not exist.

---

## What it does

- Reads a designated text channel aloud into a voice channel
- Per-user voice, style, speed, pitch and volume, saved in Supabase
- **Five-key NVIDIA load balancing** — round-robin / least-used / weighted /
  lowest-latency, with cooldowns, exponential backoff, circuit breaking and
  instant failover. One key dying never stops speech.
- Two-tier audio cache (memory LRU + disk) keyed on the exact synthesis inputs
- Per-guild ignore lists, cooldowns, blacklist, message limits
- Priority queue for premium users, with skip/pause/resume/stop/clear
- Pronunciation dictionaries, per-user and per-server
- Components V2 interactive UI

## Requirements

- Node.js 20.11+
- An NVIDIA API key from [build.nvidia.com](https://build.nvidia.com) (up to five)
- A Supabase project
- A Discord application with the **Message Content** intent enabled
- A C++ toolchain (`@discordjs/opus` compiles native bindings)

## Setup

```bash
npm install
```

Create the database schema by running `supabase/migrations/0001_initial_schema.sql`
against your project — either through the Supabase SQL editor, or:

```bash
supabase db push
```

Copy the environment template and fill it in:

```bash
cp .env.example .env
```

At minimum you need `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `NIM_KEY_1`,
`NIM_FUNCTION_ID`, `SUPABASE_URL` and `SUPABASE_KEY`. Set `DEBUG_GUILD_ID` to your
test server so slash commands register instantly instead of taking an hour.

Register the commands, then start:

```bash
npm run deploy-commands
```

```bash
npm run dev
```

## Using it

| Command | What it does |
| --- | --- |
| `/join` | Bring the bot into voice and start reading a text channel |
| `/tts <message>` | Speak one message |
| `/voice` | Interactive language / speaker / style picker with preview |
| `/settings` | Speed, pitch, volume, URL and emoji reading, spoken name |
| `/queue` `/skip` `/pause` `/resume` `/stop` `/clear` | Playback control |
| `/pronounce` | Personal and server-wide pronunciation dictionaries |
| `/favorites` `/history` | Your saved voices and recent messages |
| `/status` | Live key health, cache hit rate, latency, DB and gateway health |
| `/admin` | Channel, limits, ignore lists, blacklist, key resets, cache prune |
| `/leave` | Disconnect |

Skipping and clearing your own messages is unrestricted. Pausing, stopping and
clearing *other people's* messages need Manage Messages, so one person cannot
silence a whole channel.

## Architecture

```
Discord message
      │
      ▼
events/messageCreate ──► ignore lists, blacklist, rate limiter   (memory)
      │
      ▼
voice/ttsService ──► sanitize ──► chunk (≤20s each)
      │                             │
      │                             ├─► cache/  hit ──────────┐
      │                             │                          │
      │                             └─► nim/client ──► KeyPool │
      │                                     │  gRPC            │
      │                                     ▼                  │
      │                              grpc.nvcf.nvidia.com      │
      │                                     │                  │
      ▼                                     ▼                  ▼
voice/session (priority queue) ◄──────── raw PCM ◄─────────────┘
      │
      ▼
voice/audio ──► ffmpeg (speed, pitch, volume, normalise, 48kHz stereo)
      │
      ▼
@discordjs/voice ──► voice channel
```

### Layout

```
src/
├── cache/         two-tier audio cache, SHA-256 keyed
├── commands/      slash commands (one file per feature group)
├── config/        zod-validated environment
├── core/          composition root, mention resolvers
├── database/      Supabase client + repositories
├── events/        message, interaction and voice-state handlers
├── jobs/          cache pruning, sweeps, usage snapshots
├── middleware/    rate limiting and duplicate suppression
├── nim/           key pool, gRPC client, voice catalogue, protos
├── ui/            shared Components V2 / embed builders
├── utils/         logging, text sanitisation and chunking
└── voice/         sessions, queue, ffmpeg pipeline, synthesis service
```

### The key pool

`src/nim/keyPool.ts` is the piece worth understanding. It owns every key's
lifecycle and is transport-agnostic — it hands out a key, is told how the attempt
went, and decides what happens next.

- **429 / 5xx / timeout** → bounded cooldown, exponential in the number of
  *consecutive* failures. A merely busy key recovers fast; a broken one backs off
  hard.
- **401 / 403** → the key is disabled outright. Retrying a rejected credential
  only burns requests. `/admin resetkeys` brings it back.
- **400** → our bug, not the key's. No penalty; not retried elsewhere, because it
  would fail identically.
- **N consecutive failures** → circuit opens, then half-opens after a reset
  interval to probe with a single request.

`least-used` (the default) sorts on in-flight count first, then lifetime
requests, so a burst spreads across keys instead of stacking onto whichever key
happens to have the lowest total.

Statistics are exposed through `/status` and snapshotted hourly into `api_usage`.
Key *ids* are shown; the secrets are redacted at the log serialiser and never
appear in a stats snapshot — there is a test asserting exactly that.

## Deployment

Docker:

```bash
docker compose up -d --build
```

PM2:

```bash
npm run build && pm2 start ecosystem.config.cjs --env production
```

PM2 runs a single fork, not cluster mode, on purpose — two processes sharing one
gateway token would duplicate every event and speak everything twice. Scale with
sharding.

Mount a volume at the cache directory. Regenerating cached audio costs NIM quota,
so losing it on every restart is expensive.

## Development

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run lint
```

## Status

Working end to end: connection, channel reading, synthesis with failover,
caching, queueing, preferences, pronunciations, playback control, admin
controls, diagnostics.

Not built: the HTTP dashboard and REST API (`src/api/`, `src/dashboard/` in the
original brief), voice cloning, and automatic translation. The schema and the
`sessions` / `analytics_daily` tables anticipate the first of those; nothing else
depends on them.
