# Build Result — NIM TTS Bot

A production-grade Discord TTS bot built in TypeScript / discord.js v14, backed
by NVIDIA NIM (Magpie TTS over gRPC) and Supabase.

## Verification status

All checks pass on the committed code:

| Check | Result |
| --- | --- |
| `npm run lint` | clean (0 errors, 0 warnings) |
| `npm run typecheck` | clean |
| `npm test` | 27 passing (2 files) |
| `npm run build` | succeeds; proto copied into `dist/` |
| Boot smoke test | `dist/index.js` boots, loads the proto, and reaches NVIDIA's real gRPC endpoint over TLS |

The boot test sent auth + `function-id` metadata to `grpc.nvcf.nvidia.com:443`
and got a genuine `PERMISSION_DENIED` back (fake key), confirming the proto,
channel and metadata path all work end to end.

## What was built

A greenfield `src/` tree. The existing Python files were left untouched alongside it.

- **NIM key pool** ([src/nim/keyPool.ts](src/nim/keyPool.ts)) — transport-agnostic
  balancer. Hands out a key, is told the outcome, decides what happens next:
  - 429 / 5xx / timeout → bounded cooldown, exponential in *consecutive* failures
  - 401 / 403 → key disabled outright (retrying a rejected credential only burns quota)
  - 400 → treated as our bug; no penalty, not retried elsewhere
  - N consecutive failures → circuit opens, half-opens later to probe with one request
  - `least-used` sorts on in-flight count first, then lifetime count, so bursts
    spread across keys instead of stacking
- **gRPC client** ([src/nim/client.ts](src/nim/client.ts)) — drives Riva/Magpie
  directly (no official Node client exists); per-call auth metadata over one shared channel
- **Two-tier audio cache** ([src/cache/index.ts](src/cache/index.ts)) — memory LRU
  in front of disk, SHA-256 keyed on exact synthesis inputs
- **Supabase schema** ([supabase/migrations/0001_initial_schema.sql](supabase/migrations/0001_initial_schema.sql))
  — normalized tables, indexes, RLS, `updated_at` triggers
- **ffmpeg pipeline** ([src/voice/audio.ts](src/voice/audio.ts)) — 22.05 kHz mono →
  48 kHz stereo, plus speed/pitch/volume shaping and loudness normalisation
- **Voice sessions** ([src/voice/session.ts](src/voice/session.ts)) — priority queue,
  skip/pause/resume/stop/clear, auto-reconnect, idle auto-leave
- **19 slash commands**, Components V2 UI, per-user & per-guild prefs, pronunciation
  dictionaries, blacklist, admin controls, `/status` diagnostics
- **Deployment**: Dockerfile, docker-compose, PM2 ecosystem config, GitHub Actions CI,
  ESLint, Prettier

## Bugs caught during verification

1. **`tsc` doesn't copy `.proto` files.** The client resolves its proto relative
   to the compiled file, so *every production boot* (Docker and PM2 both run
   `dist/`) would have crashed at startup. Fixed with
   [scripts/copy-assets.mjs](scripts/copy-assets.mjs) wired into the build.

2. **Voice discovery was cooling down keys at boot.** The live boot test showed
   NVIDIA returning `PERMISSION_DENIED` and the pool applying a 60s cooldown.
   `GetRivaSynthesisConfig` may not be routable through an NVCF function-id at
   all — meaning *all five keys* could be cooling before the first user request.
   Discovery now releases keys without penalty, with a regression test.

3. **Markdown stripping ate custom emoji.** `<:big_smile:123>` lost its
   underscore to the italic rule and came out "bigsmile". Reordered the
   sanitisation pipeline (mentions + emoji resolved before markdown stripping).

---

## Things worth your attention to look over

### 1. The catalogue is much smaller than the original spec

Magpie TTS Multilingual has **12 locales, 13 speakers (not in every locale), and
7 emotions** — not the 30 accents and 23 personas the brief described.

- **Not available at all:** British / Australian / Irish / Scottish / NZ / South
  African English; Tamil, Telugu, Bengali, Urdu, Russian, Turkish, Thai,
  Indonesian, Polish, Dutch.
- **No persona voices** — there is no "Anime", "Robot", "Narrator", "Podcast",
  "Streamer", "Whisper", "child voice", etc. Those concepts don't exist in this model.
- **No rate / pitch / volume parameters and no SSML.** Speed, pitch and volume
  are applied in ffmpeg *after* synthesis; extreme values will sound processed.
- **20-second audio cap per request.** Long messages are chunked on sentence
  boundaries and concatenated.

Because the exact speaker/locale matrix isn't fully documented,
[src/nim/voices.ts](src/nim/voices.ts) seeds only verified pairs and reconciles
against the live service at boot, so `/voice` can never offer a combination that
doesn't exist. Full detail in [NIM-LIMITATIONS.md](NIM-LIMITATIONS.md).

### 2. The licensing boundary around the hosted endpoints

NVIDIA's hosted `build.nvidia.com` endpoints are documented for **prototyping and
development**. Serving real end users is "production" under NVIDIA's terms and
requires an **NVIDIA AI Enterprise licence**.

The five-key rotation is genuinely useful engineering — it survives transient
429s/5xx and fails over instantly. But if the *reason* for five keys is to
multiply a free prototyping quota into production capacity, that's a licensing
boundary rather than a technical one, and NVIDIA can close it by rate-limiting
per **account** rather than per key (there are reports of exactly that).

Two honest paths to production:
1. **Licence it** — NVIDIA AI Enterprise, or self-host the TTS NIM container on
   your own GPU (removes the rate limits *and* the licensing question; the same
   gRPC client points at `localhost:50051`).
2. **Use a provider whose free tier permits this** — e.g. the `edge-tts` the
   Python prototype used, which is free, needs no key, and covers *more*
   languages and accents than Magpie does (worse audio, cleaner legal position).

### 3. Native opus encoder swapped for pure JS

`@discordjs/opus` needs Visual Studio build tools, which aren't installed on this
machine, so I swapped it for `opusscript` (pure JS, works everywhere, slightly
slower). Switch back to the native encoder once a C++ toolchain is available if
you want the performance.

### 4. Not built (flagged rather than stubbed)

- HTTP dashboard and REST API (`src/api/`, `src/dashboard/` in the brief)
- Voice cloning
- Automatic translation

The `sessions` / `analytics_daily` tables anticipate the dashboard; nothing else
depends on them.

---

## Running it

1. Fill in `.env` (see [.env.example](.env.example)) — at minimum `DISCORD_TOKEN`,
   `DISCORD_CLIENT_ID`, `NIM_KEY_1`, `NIM_FUNCTION_ID`, `SUPABASE_URL`, `SUPABASE_KEY`.
2. Apply `supabase/migrations/0001_initial_schema.sql` to your Supabase project.
3. Register commands and start:

```bash
npm run deploy-commands && npm run dev
```

## Sources

- [Voices and emotional styles](https://docs.nvidia.com/nim/speech/latest/tts/voices.html)
- [TTS support matrix](https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/tts.html)
- [TTS quickstart](https://docs.nvidia.com/nim/speech/latest/get-started/tutorials/tts.html)
- [LiveKit Riva plugin](https://docs.livekit.io/agents/models/tts/nvidia/) (NVCF endpoint and function id)
