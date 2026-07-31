# NIM TTS Bot — Build & Review Summary

A production-grade Discord TTS bot built in TypeScript / discord.js v14, backed
by NVIDIA NIM (Magpie TTS over gRPC) and Supabase. This file summarises the
build verification and the full engineering review. Use it as a brief for
deciding what to work on next.

The full review with code snippets and proposed solutions is in [REVIEW.md](REVIEW.md).

---

## Build verification

All checks pass on the committed code:

| Check | Result |
| --- | --- |
| `npm run lint` | clean (0 errors, 0 warnings) |
| `npm run typecheck` | clean |
| `npm test` | 27 passing (2 files) |
| `npm run build` | succeeds; proto copied into `dist/` |
| Boot smoke test | boots, loads the proto, reaches NVIDIA's real gRPC endpoint over TLS |

The boot test sent real auth metadata to `grpc.nvcf.nvidia.com:443` and got a
genuine `PERMISSION_DENIED` back (fake key), confirming the proto, channel and
metadata path all work end to end.

---

## What was built

- **NIM key pool** ([src/nim/keyPool.ts](src/nim/keyPool.ts)) — transport-agnostic balancer with 4 strategies (round-robin, least-used, lowest-latency, weighted), exponential cooldown, and circuit breaker
- **gRPC client** ([src/nim/client.ts](src/nim/client.ts)) — drives Riva/Magpie directly with per-call auth metadata and automatic retry/failover across keys
- **Two-tier audio cache** ([src/cache/index.ts](src/cache/index.ts)) — memory LRU in front of disk, SHA-256 keyed on exact synthesis inputs
- **Supabase schema** ([supabase/migrations/0001_initial_schema.sql](supabase/migrations/0001_initial_schema.sql)) — normalized tables, indexes, RLS, `updated_at` triggers
- **ffmpeg pipeline** ([src/voice/audio.ts](src/voice/audio.ts)) — 22.05 kHz mono → 48 kHz stereo, speed/pitch/volume shaping, loudness normalisation
- **Voice sessions** ([src/voice/session.ts](src/voice/session.ts)) — priority queue, skip/pause/resume/stop/clear, auto-reconnect, idle auto-leave
- **19 slash commands**, Components V2 UI, per-user & per-guild prefs, pronunciation dictionaries, blacklist, admin controls, `/status` diagnostics
- **Deployment:** Dockerfile, docker-compose, PM2 ecosystem config, GitHub Actions CI, ESLint, Prettier

---

## Engineering review — findings

16 verified findings. Severity: **3 Critical / 5 High / 4 Medium / 2 Low** (plus 2 low cosmetic).

### Critical — fix before any production traffic

#### #1 — ffmpeg processes are never killed `src/voice/audio.ts`

When a user calls `/skip` or `/stop`, discord.js stops reading `proc.stdout`.
ffmpeg blocks on a full pipe and sits there indefinitely — the handle is never
returned. Every skip leaks one ffmpeg process (~10–30 MB RSS + a pipe pair).
On a busy 1,000-guild instance this is measured in hours before PID/FD
exhaustion. The Docker image sets no `--pids-limit`.

**Fix:** Return `{ stream, dispose() }` from `processAudio()` instead of a bare
`Readable`. Call `dispose()` from `skip()`, `stop()`, the `Idle` handler, and
`destroy()`. Use `SIGKILL` — ffmpeg blocked on a full pipe may not honour `SIGTERM`.
~30 lines across two files.

#### #2 — `areverse` forces full buffering; the pipeline does not stream `src/voice/audio.ts`

The trailing-silence trim uses two `areverse` filters plus single-pass
`loudnorm`. Both buffer the entire clip. The function's docstring says "playback
can begin before the whole clip has been transcoded" — with `normalize: true`
(the default), that is false for every request. All audio is held in ffmpeg
until the full clip is processed.

**Fix (recommended):** Drop trailing-silence trim (TTS model output has short,
predictable silence). Replace `loudnorm + areverse` with `dynaudnorm`, which
streams. ~5 lines in `buildFilterGraph`.

#### #3 — Four repository caches grow without bound `src/database/repositories/`

`userRepository`, `guildRepository`, `pronunciationCache` (in `ttsRepository`),
and `premiumCache` (in `ttsRepository`) are all plain `Map`s with TTL checked on
read. Nothing ever deletes an expired entry. A user seen once is cached forever.
`AudioCache` got LRU eviction; these four were missed. This is the most likely
cause of a slow OOM on a live instance. PM2's `max_memory_restart: '1G'` papers
over it with restarts.

**Fix:** A shared `TtlCache<V>` class (new file `src/cache/ttlCache.ts`) that
evicts by LRU on `set()` and prunes expired entries on `sweep()`. Wire `sweep()`
into the maintenance job. Four mechanical call-site changes. ~60 lines total.

---

### High — materially better stability and latency

#### #4 — Queue holds decoded PCM; no per-user fairness cap `src/voice/session.ts`

`QueueItem.pcm` is a decoded `Buffer`. Raw PCM at 22.05 kHz mono is ~44 KB/s.
50 × 15-second messages = ~33 MB **per guild** held in memory until played. One
user can monopolise all 50 queue slots.

**Fix (short-term):** Per-user cap at ~20% of max queue size. ~10 lines in `enqueue()`.
**Fix (real):** Lazy synthesis — queue `{ text, preferences }`, synthesize only
when near the head of the queue. Bounds resident audio to a small lookahead window
regardless of queue depth, and skipped items are never synthesized (saves NIM quota).

#### #5 — `toEffectivePreferences` silently overrides explicit user choices `src/database/repositories/userRepository.ts:124`

The function decides a user is "unconfigured" by comparing their stored voice
against hardcoded defaults. It cannot distinguish "never configured" from
"deliberately chose the defaults." A user who explicitly picks Mia/Neutral/en-US
gets silently overridden by guild defaults on every message.

**Fix:** Add `voice_configured_at timestamptz` nullable column. Set it in
`applyVoiceSelection`. Change the check to `user.voice_configured_at === null`.

#### #6 — Chunks are synthesized sequentially `src/voice/ttsService.ts:87`

`for (const chunk of chunks) { await ... }` — a 4-chunk message costs 4× the
NIM round-trip serially (~1.6 s before a word plays at 400 ms/call). The chunks
are independent; only concatenation order matters.

**Fix:** Bounded parallel synthesis (concurrency = 3, preserving order). ~15 lines.

#### #7 — No in-flight request collapsing `src/voice/ttsService.ts:95`

Cache is consulted, and on a miss NIM is called immediately. Ten users posting
the same phrase within the same second produce ten identical NIM calls before any
of them finishes writing to the cache. This is precisely the burst pattern that
triggers 429s.

**Fix:** A `Map<string, Promise<Buffer>>` keyed by the same hash as the cache.
Check before issuing; delete in `finally`. ~20 lines in `TtsService`.

#### #8 — `usage_logs` and `voice_history` have no retention `src/database/repositories/ttsRepository.ts`

Append-only, unbounded. A busy 1,000-guild instance writes millions of rows/month
into a Supabase free tier with a 500 MB ceiling. When full, all writes fail —
including preference updates.

**Fix (immediate):** SQL retention job deleting rows older than 30 / 90 days.
**Fix (better):** Buffer usage inserts and flush every 10 s or 100 rows. Roll
`usage_logs` into `analytics_daily` (table already exists, currently unwritten)
beyond 7 days.

#### #9 — Memory cache bounded by entry count, not bytes `src/cache/index.ts`

`CACHE_MEMORY_MAX_ENTRIES=500`. Entry count is a poor proxy — 500 one-second
clips is ~22 MB; 500 twenty-second clips is ~440 MB. The `bytes` field on
`MemoryEntry` is already populated but ignored during eviction.

**Fix:** Track a running byte total in `putMemory`; evict on bytes. Add
`CACHE_MEMORY_MAX_BYTES` (suggest 128 MB) to config. ~10 lines.

---

### Medium

#### #10 — Blacklist drifts across processes `src/database/repositories/ttsRepository.ts:263`

Module-level set loaded once at boot. A blacklist applied on shard 1 is invisible
to shard 2. Currently safe (single process), but the README already anticipates
sharding.

**Fix:** Add `loadBlacklist()` to the maintenance job (60 s interval) — a one-liner.

#### #11 — `ephemeral: true` is deprecated (49 occurrences across 9 files)

Should be `flags: MessageFlags.Ephemeral`. Will break on a future discord.js
major. Already inconsistent — `interactionCreate.ts` uses the new form while
everything else uses the boolean.

**Fix:** Mechanical replacement. One isolated commit.

#### #12 — Components V2 flags on `editReply` after a plain defer

Several commands defer without `IsComponentsV2` then `editReply` with it.
Unverified against the live API — the boot test never reached a real interaction.
If Discord rejects it, the success path fails at reply time. The error paths pass
plain `content` on a possibly-V2 message; one of the two is broken.

**Fix:** Verify with a live interaction first. Set the flag at defer time; keep
every subsequent edit V2-shaped (wrap error text in `container()` rather than
`content`). Do not fix blind.

#### #13 — Dead code and never-populated fields

| Symbol | Status |
| --- | --- |
| `estimateDurationMs` (audio.ts:158) | Defined, never called |
| `memberDisplayName` (speak.ts:211) | Defined, never called |
| `keysUsed` (ttsService.ts:44) | Computed and returned, never read |
| `estimatedQuotaRemaining` (keyPool.ts:361) | Always hardcoded `null` |
| `rateLimitHits` (keyPool.ts:283) | Tracked but never exposed in `stats()` |

The last one matters: `rateLimitHits` is tracked correctly but never surfaced,
which is why `api_usage.rate_limited` writes a hardcoded zero with a comment
saying the value is unavailable. It is available. A five-line fix turns a dead
analytics column into a real one.

#### #14 — `NIM_SAMPLE_RATE_HZ` is configurable but must not be

Magpie always emits 22.05 kHz. Setting this to 48000 produces chipmunk audio
with no error. It is also part of the cache key, so changing it silently
invalidates the entire cache.

**Fix:** Move to `const MAGPIE_SAMPLE_RATE_HZ = 22_050` in `voices.ts`. Drop
from env. XS change.

---

### Low

#### #15 — Read-modify-write race on preferences `src/database/repositories/userRepository.ts:98`

Two rapid `/voice` interactions can interleave such that the second write is
built from a pre-first-write snapshot, losing one update.

**Fix:** Send only changed columns rather than the full merged row.

#### #16 — Duplicate import `src/events/interactionCreate.ts:15`

`userRepository.js` imported twice. Enable `no-duplicate-imports` ESLint rule.

---

## Scalability estimate

| Scale | Status |
| --- | --- |
| 100 guilds | Fine as-is. Leaks too slow to matter with daily restarts. |
| 1,000 guilds | Findings #1, #3, #4 become binding. OOM/PID exhaustion within hours to days. Fix those first. |
| 10,000 guilds | Requires sharding → surfaces #10 (blacklist drift) + per-shard module caches. Supabase write volume (#8) becomes the next wall. |
| 100,000 guilds | Different architecture needed. Also beyond what NVIDIA's hosted endpoints permit (the real ceiling — see [NIM-LIMITATIONS.md](NIM-LIMITATIONS.md)). |

---

## Prioritised roadmap

### Do first (critical, each under ~1 hour)

1. Kill ffmpeg on skip/stop (#1) — `src/voice/audio.ts`, `src/voice/session.ts`
2. Replace `areverse + loudnorm` with `dynaudnorm` (#2) — `src/voice/audio.ts`
3. Add `TtlCache` class; wire into 4 repositories (#3) — `src/cache/ttlCache.ts` + repositories
4. Verify Components V2 `editReply` with a live interaction (#12)
5. Add retention SQL to maintenance job (#8) — `src/jobs/maintenance.ts`

### Do next (high, each under ~2 hours)

6. Per-user queue cap → lazy synthesis (#4) — `src/voice/session.ts`
7. Parallel chunk synthesis, concurrency = 3 (#6) — `src/voice/ttsService.ts`
8. In-flight request collapsing (#7) — `src/voice/ttsService.ts`
9. Byte-bounded memory cache (#9) — `src/cache/index.ts`
10. Fix preference-override bug, add `voice_configured_at` column (#5)
11. Plumb `rateLimitHits` into `stats()` (#13) — `src/nim/keyPool.ts`
12. Background health probes for cooling/open keys
13. Retry budget (global token bucket across all requests)

### Medium (quality of life)

14. Replace `ephemeral: true` with `MessageFlags.Ephemeral` (#11)
15. Delete dead code; decide on `estimatedQuotaRemaining` (#13)
16. Make sample rate a model constant, drop from env (#14)
17. Convert repositories to injected classes (enables `TtsService` unit tests)
18. Move `describeFailure` to `src/utils/errors.ts`
19. Tests for `AudioCache` and `buildFilterGraph`
20. Pagination for `/history`, `/favorites`, `/queue`
21. `/metrics` HTTP endpoint + Docker `HEALTHCHECK`
22. Periodic blacklist reload (#10)

### Low / future

23. Partial-column preference updates (#15)
24. Duplicate import + `no-duplicate-imports` rule (#16)
25. Warm ffmpeg process or JS resampler for no-shaping common case
26. Modals for bulk pronunciation import
27. Wire up `analytics_daily` + `sessions` tables, or drop them
28. `SynthesizeOnline` streaming (largest remaining latency win)
29. Shared Redis cache (prerequisite for sharding)
30. Self-hosted NIM (resolves licensing ceiling + rate limits in one move)

---

## Known limitations of the NIM provider

- **12 locales, 13 speakers, 7 emotions** — not the 30 accents and 23 personas the original spec described
- **No SSML, no rate/pitch/volume parameters** — speed, pitch, volume applied by ffmpeg post-synthesis
- **20-second cap per request** — long messages are chunked and concatenated
- **gRPC only** — no REST API for TTS
- **Hosted endpoints are documented for prototyping/development** — production use requires NVIDIA AI Enterprise licence; 5-key rotation is a technical resilience measure but does not change the licensing boundary

---

## Bugs caught during build (already fixed)

1. **`tsc` doesn't copy `.proto` files** — every production boot would crash. Fixed with [scripts/copy-assets.mjs](scripts/copy-assets.mjs)
2. **Voice discovery was cooling all keys at boot** — PERMISSION_DENIED on `GetRivaSynthesisConfig` applied 60s cooldown to the whole pool. Discovery now uses `release()` (no penalty) instead of `reportFailure()`
3. **Markdown stripping ate custom emoji** — `<:big_smile:123>` lost its underscore to the italic rule. Fixed by reordering the sanitise pipeline (mentions + emoji before markdown stripping)

---

## Running it

1. Fill in `.env` (see [.env.example](.env.example)) — minimum: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `NIM_KEY_1`, `NIM_FUNCTION_ID`, `SUPABASE_URL`, `SUPABASE_KEY`
2. Apply [supabase/migrations/0001_initial_schema.sql](supabase/migrations/0001_initial_schema.sql) to your Supabase project
3. Register commands and start:

```bash
npm run deploy-commands && npm run dev
```
