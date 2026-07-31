# Engineering Review — NIM TTS Bot

A critical review of the current implementation. Every finding below was
verified against the actual source, not inferred. Line references are real.

Findings are ordered by severity, not by the section they belong to. A tidy
taxonomy that buries a resource leak under "code style" is a worse deliverable
than an ordered one.

**Summary of what I found:** the architecture is sound and does not need
restructuring. The layering, repository pattern, DI via the composition root,
and the key pool design are all fine and should be preserved. What it has is a
set of concrete defects — three of which will take down a busy instance — plus
a batch of things that are simply not wired up (dead fields, unused outputs).

---

## Severity index

| # | Finding | Severity | Effort |
| --- | --- | --- | --- |
| 1 | ffmpeg processes are never killed | **Critical** | S |
| 2 | `areverse` forces full-stream buffering, defeating streaming | **Critical** | S |
| 3 | Four repository caches grow without bound | **Critical** | M |
| 4 | Queue holds decoded PCM; no per-user cap | **High** | M |
| 5 | `toEffectivePreferences` silently overrides explicit user choice | **High** | S |
| 6 | Chunks synthesized sequentially | **High** | S |
| 7 | No in-flight request collapsing | **High** | M |
| 8 | `usage_logs` / `voice_history` grow without retention | **High** | S |
| 9 | Memory cache bounded by entry count, not bytes | **High** | S |
| 10 | Blacklist state drifts across processes | **Medium** | M |
| 11 | `ephemeral: true` deprecated (49 occurrences) | **Medium** | S |
| 12 | Components V2 flags on `editReply` after plain defer | **Medium** | S |
| 13 | Dead code and never-populated fields | **Medium** | S |
| 14 | `NIM_SAMPLE_RATE_HZ` is configurable but must not be | **Medium** | XS |
| 15 | Read-modify-write races on preferences | **Low** | S |
| 16 | Duplicate import | **Low** | XS |

---

## 1. ffmpeg processes are never killed — Critical

**Current implementation.** [src/voice/audio.ts:136](src/voice/audio.ts#L136) spawns
an ffmpeg child per queue item and returns `proc.stdout`. Grepping the file for
`kill` returns nothing — there is no code path anywhere that terminates the
child.

**The issue.** The process is only reaped if ffmpeg exits on its own after
draining stdin and flushing stdout. When `VoiceSession.skip()` or `stop()` calls
`player.stop(true)` ([src/voice/session.ts:225](src/voice/session.ts#L225)),
discord.js destroys the *resource*, which stops reading `proc.stdout`. ffmpeg
then blocks writing to a full pipe and sits there indefinitely.

**Root cause.** The stream is treated as the unit of ownership, but the process
is the actual resource. Returning a bare `Readable` throws away the handle.

**Impact.** Every skip leaks one ffmpeg process holding ~10–30 MB RSS and a
pipe pair. A guild where people skip frequently accumulates zombies until the
host hits its process or file-descriptor limit. On a 1,000-guild instance this
is measured in hours, not weeks. Worth noting the Docker image sets no
`--pids-limit`, so the container will exhaust host PIDs rather than fail early.

**Proposed solution.** Return the process alongside the stream and kill it on
resource teardown.

```ts
export interface ProcessedAudio {
  stream: Readable;
  /** Terminate ffmpeg. Idempotent; safe to call after natural exit. */
  dispose(): void;
}

export function processAudio(...): ProcessedAudio {
  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  // ...existing handlers...

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    proc.stdout.destroy();
    proc.stdin.destroy();
    if (proc.exitCode === null) proc.kill('SIGKILL');
  };

  proc.once('close', () => { disposed = true; });
  return { stream: proc.stdout, dispose };
}
```

In `VoiceSession`, hold the current `dispose` and call it from the `Idle`
handler, the `error` handler, `skip()`, `stop()` and `destroy()`. Use `SIGKILL`
rather than `SIGTERM`: ffmpeg blocked on a full pipe will not always honour a
graceful signal.

**Complexity** Small. ~30 lines across two files.
**Performance impact** Strictly positive.
**Breaking changes** `processAudio`'s return type changes. Internal only.
**Migration** Change the two call sites; no data or config migration.

---

## 2. `areverse` forces full-stream buffering — Critical

**Current implementation.** [src/voice/audio.ts:86-92](src/voice/audio.ts#L86)
trims trailing silence with the standard `silenceremove` + `areverse` trick, then
applies `loudnorm`.

**The issue.** `areverse` cannot stream — by definition it must hold the entire
input before emitting its first sample. The filter chain contains **two** of
them. Single-pass `loudnorm` additionally buffers ~3 seconds for its lookahead.

The file's own docstring says the function "returns a stream rather than a buffer
so playback can begin before the whole clip has been transcoded"
([src/voice/audio.ts:106](src/voice/audio.ts#L106)). With `normalize: true` —
which is `DEFAULT_SHAPING`, so it is on for every single request — that is not
what happens. No audio is emitted until the whole clip is processed.

**Root cause.** The trailing-silence idiom was applied without checking its
streaming characteristics against the stated design goal.

**Impact.** Time-to-first-word includes the full transcode instead of
overlapping with it. It also means peak memory per item is the whole decoded
clip held inside ffmpeg, on top of the copy already in the queue (finding #4).

**Proposed solution.** Pick one:

- **Cheapest and my recommendation:** drop the trailing trim. The audio comes
  from a TTS model, not a microphone — trailing silence is short and predictable.
  Keep the leading `silenceremove` (which *is* streaming) and replace `loudnorm`
  with `dynaudnorm` or a static `volume` adjustment. Both stream.
- If true loudness normalisation is required, accept the buffering but stop
  claiming the function streams, and measure the added latency before shipping.

```ts
if (shaping.normalize) {
  filters.push(
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05:detection=peak',
    // dynaudnorm streams; loudnorm + areverse do not.
    'dynaudnorm=f=200:g=5:p=0.9',
  );
}
```

**Complexity** Small.
**Performance impact** Large improvement to time-to-first-word and peak memory.
**Breaking changes** Output loudness characteristics shift slightly.
**Migration** None. Consider bumping the cache key if you ever cache
post-shaping audio (you currently cache pre-shaping, which is the right call).

---

## 3. Four repository caches grow without bound — Critical

**Current implementation.** Verified by grep:

- [userRepository.ts:24](src/database/repositories/userRepository.ts#L24)
- [guildRepository.ts:24](src/database/repositories/guildRepository.ts#L24)
- [ttsRepository.ts:93](src/database/repositories/ttsRepository.ts#L93) (pronunciations)
- [ttsRepository.ts:221](src/database/repositories/ttsRepository.ts#L221) (premium)

**The issue.** Every one is a plain `Map` with a TTL checked *on read*. Nothing
ever deletes an expired entry. A user seen once is cached forever; the TTL only
controls whether the stale value is re-fetched, not whether the memory is
released.

`AudioCache` got an LRU bound and `RateLimiter` got a `sweep()` — these four
were simply missed.

**Impact.** `UserRow` is roughly 300 bytes plus overhead. A bot across 10,000
guilds seeing 500k distinct users accumulates a few hundred MB of permanently
retained rows, and it never comes back down. This is the single most likely
cause of a slow OOM in production. The PM2 config's `max_memory_restart: '1G'`
will paper over it with restarts, which is a symptom, not a fix.

**Proposed solution.** One shared bounded-TTL cache, used by all four sites.

```ts
// src/cache/ttlCache.ts
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();
  constructor(private readonly maxEntries: number, private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) { this.map.delete(key); return undefined; }
    this.map.delete(key); this.map.set(key, e);   // LRU recency
    return e.value;
  }

  set(key: string, value: V): void {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
  get size(): number { return this.map.size; }
  /** Drop expired entries; call from the maintenance job. */
  sweep(): number { /* … */ }
}
```

Register a `sweep()` for each in [src/jobs/maintenance.ts](src/jobs/maintenance.ts)
alongside the existing rate-limiter sweep, and expose sizes via `/status`.

**Complexity** Medium — new class plus four mechanical call-site changes.
**Performance impact** Bounded memory; negligible CPU.
**Breaking changes** None; the repository APIs are unchanged.
**Migration** None.

---

## 4. Queue holds decoded PCM; no per-user cap — High

**Current implementation.** `QueueItem.pcm` is a `Buffer`
([src/voice/session.ts:35](src/voice/session.ts#L35)), and `MAX_QUEUE_SIZE`
defaults to 50 with no per-user sub-limit.

**The issue.** Two problems compound.

*Memory.* Raw PCM at 22.05 kHz mono 16-bit is ~44 KB per second. A 15-second
message is ~660 KB. Fifty of those is ~33 MB **per guild**, resident until
played. Across a few hundred active guilds that is gigabytes.

*Fairness.* One user can occupy all 50 slots. `/clear` requires Manage Messages
to clear others, so on a server without an active moderator a single person can
monopolise the queue until it drains.

**Root cause.** Synthesis was made eager (produce audio, then queue it) rather
than lazy (queue the request, synthesize when near the head).

**Proposed solution.**

- **Per-user cap:** reject when a user already holds more than ~20% of the
  queue. Roughly ten lines in `enqueue()`.
- **Lazy synthesis (the real fix):** queue `{ text, preferences }` and synthesize
  when an item reaches within N positions of the head. This bounds resident
  audio to the small lookahead window regardless of queue depth, and has the
  bonus that skipped items are never synthesized at all — saving NIM quota,
  which is your scarcest resource.

The second change touches `VoiceSession` and both enqueue call sites
([speak.ts](src/commands/speak.ts), [messageCreate.ts](src/events/messageCreate.ts)).
It is the highest-leverage change in this document after the leaks.

**Complexity** Small for the cap; Medium for lazy synthesis.
**Performance impact** Large memory reduction; lower NIM spend.
**Breaking changes** Internal only.
**Risks** Lazy synthesis moves failure from enqueue-time to play-time, so
failures can no longer be reported in the command response. Log and react
instead.

---

## 5. `toEffectivePreferences` overrides explicit user choice — High

**Current implementation.** [userRepository.ts:124-133](src/database/repositories/userRepository.ts#L124)
decides a user is "untouched" by comparing their stored voice against the
defaults, and if so substitutes guild defaults.

**The issue.** It cannot distinguish "never configured" from "deliberately chose
the values that happen to be the defaults." A user who opens `/voice` and
explicitly selects Mia / Neutral / en-US gets silently overridden by the guild
default on every message. From their side, the setting simply does not stick —
and `/settings show` will display their choice correctly, making it look like a
bot bug rather than a config precedence rule.

**Root cause.** Inferring intent from values instead of recording it.

**Proposed solution.** Record the fact explicitly. Add a nullable column and
treat `null` as "not configured":

```sql
alter table public.users add column voice_configured_at timestamptz;
```

Set it in `applyVoiceSelection`, and change the check to
`const untouched = user.voice_configured_at === null;`.

Alternatively make `locale` / `speaker` / `emotion` nullable and let `null` mean
inherit — cleaner modelling, but a larger migration.

**Complexity** Small.
**Breaking changes** Additive column.
**Migration** Backfill `voice_configured_at = updated_at` where the row differs
from defaults; leave `null` otherwise. Existing deliberate-default users stay
misclassified once, then self-correct on their next `/voice` interaction.

---

## 6. Chunks are synthesized sequentially — High

**Current implementation.** [ttsService.ts:87](src/voice/ttsService.ts#L87) —
`for (const chunk of chunks) { await ... }`.

**The issue.** A message split into four chunks costs 4× the round-trip latency,
serially. With a ~400 ms NIM call that is 1.6 s before a word is spoken. The
chunks are independent; only the concatenation order matters.

**Proposed solution.** Bounded parallelism preserving order. Do not use an
unbounded `Promise.all` — with five keys and a 50-deep queue you would burst
straight into the rate limits the key pool exists to avoid.

```ts
const CHUNK_CONCURRENCY = 3;
const parts = new Array<Buffer>(chunks.length);

for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
  const window = chunks.slice(i, i + CHUNK_CONCURRENCY);
  const settled = await Promise.all(
    window.map((chunk, j) => synthesizeChunk(chunk).then((buf) => [i + j, buf] as const)),
  );
  for (const [index, buf] of settled) parts[index] = buf;
}
```

Note this interacts with the key pool's `least-used` strategy in a good way:
concurrent chunks land on different keys, so a single long message spreads
across the pool instead of hammering one key.

**Complexity** Small.
**Performance impact** Near-linear latency reduction for multi-chunk messages.
**Risks** Higher instantaneous key pressure. Keep concurrency ≤ pool size.

---

## 7. No in-flight request collapsing — High

**Current implementation.** [ttsService.ts:95-114](src/voice/ttsService.ts#L95) —
cache is consulted, and on a miss NIM is called. There is no record of requests
already in flight.

**The issue.** The cache only helps *after* the first request completes. Ten
users posting the same catchphrase within the same second produce ten identical
NIM calls, because none of them has finished writing to the cache yet. This is
precisely the burst pattern that triggers 429s.

**Proposed solution.** A promise map keyed by the same hash as the cache.

```ts
private readonly inFlight = new Map<string, Promise<Buffer>>();

private async synthesizeChunk(key: string, req: SynthesisRequest): Promise<Buffer> {
  const existing = this.inFlight.get(key);
  if (existing) return existing;

  const promise = this.nim.synthesize(req)
    .then((r) => { void this.cache.set(key, r.audio); return r.audio; })
    .finally(() => this.inFlight.delete(key));

  this.inFlight.set(key, promise);
  return promise;
}
```

The `finally` is what keeps the map bounded — it must not be omitted, or this
becomes leak number five.

**Complexity** Medium.
**Performance impact** Large reduction in duplicate NIM spend under exactly the
conditions that cause rate limiting.
**Breaking changes** None.

---

## 8. Telemetry tables have no retention — High

**Current implementation.** `logUsage` inserts a row per synthesis
([ttsRepository.ts:225](src/database/repositories/ttsRepository.ts#L225)) and
`recordHistory` inserts a row per message
([ttsRepository.ts:22](src/database/repositories/ttsRepository.ts#L22)). The
schema defines indexes but no retention policy.

**The issue.** These are append-only and unbounded. A busy 1,000-guild instance
writes millions of rows a month into a Supabase free tier with a 500 MB ceiling.
When it fills, *every* write fails — including preference updates.

Secondary issue: one INSERT per spoken message means the database write rate
equals the message rate. At scale that is the dominant query load, and it is on
the hot path (fire-and-forget, so it does not add latency, but it does consume
connections).

**Proposed solution.**

- **Retention:** a `pg_cron` job, or extend the existing maintenance job:
  ```sql
  delete from public.voice_history where created_at < now() - interval '30 days';
  delete from public.usage_logs   where created_at < now() - interval '90 days';
  ```
- **Batching:** buffer usage rows in memory and flush every ~10 s or 100 rows.
  Accepts losing the last few seconds on a crash, which is fine for analytics.
- Longer term, roll `usage_logs` into `analytics_daily` (the table already
  exists and is currently unwritten) and keep only the rollup beyond 7 days.

**Complexity** Small for retention; Medium for batching.

---

## 9. Memory cache bounded by entries, not bytes — High

**Current implementation.** `CACHE_MEMORY_MAX_ENTRIES=500`
([src/cache/index.ts](src/cache/index.ts)). `MemoryEntry` already tracks `bytes`,
but eviction only counts entries.

**The issue.** Entry count is a poor proxy for memory when items vary by two
orders of magnitude. 500 one-second clips is ~22 MB; 500 twenty-second clips is
~440 MB. The configuration gives no way to bound the thing that actually matters.

The `bytes` field being present but unused suggests this was intended and not
finished.

**Proposed solution.** Track a running total and evict on bytes, keeping the
entry cap as a secondary bound. `MemoryEntry.bytes` is already populated, so this
is a small change confined to `putMemory`. Add `CACHE_MEMORY_MAX_BYTES`
(suggest 128 MB) to config and `.env.example`.

**Complexity** Small.

---

## 10. Blacklist drifts across processes — Medium

**Current implementation.** `loadBlacklist()` populates a module-level set at
boot; `addToBlacklist` / `removeFromBlacklist` mutate it in the calling process
only ([ttsRepository.ts:263](src/database/repositories/ttsRepository.ts#L263)).

**The issue.** Correct today because you run one process — but the README
already advises sharding for scale, and PM2 is configured single-fork precisely
because of the gateway constraint. The moment there is a second shard, a
blacklist applied on shard 1 is invisible to shard 2 indefinitely: nothing ever
reloads it.

**Proposed solution.** Add a periodic `loadBlacklist()` to the maintenance job
(60 s is ample), or subscribe to Supabase Realtime on the `blacklist` table for
immediate propagation. The periodic reload is trivial and sufficient.

**Complexity** Medium (Realtime) / XS (periodic reload).

---

## 11. `ephemeral: true` is deprecated — Medium

**Current implementation.** 49 occurrences across 9 files (verified by grep).

**The issue.** discord.js deprecated the `ephemeral` boolean in favour of
`flags: MessageFlags.Ephemeral`. It still works, but emits deprecation warnings
and will break on a future major. The codebase is already inconsistent —
[interactionCreate.ts](src/events/interactionCreate.ts) uses `MessageFlags.Ephemeral`
in `replyWithError` while everything else uses the boolean.

**Proposed solution.** Mechanical replacement. Because `v2Flags()` already
composes flags, the cleanest form is a small helper used everywhere:

```ts
export function ephemeral(): number { return MessageFlags.Ephemeral; }
```

**Complexity** Small, but touches many files — do it as an isolated commit so it
does not obscure behavioural changes in review.

---

## 12. Components V2 flags on `editReply` after a plain defer — Medium

**Current implementation.** Several commands defer with
`deferReply({ ephemeral: true })` and then `editReply({ components, flags: v2Flags(true) })`
— see [status.ts:60](src/commands/status.ts#L60) and
[speak.ts:150](src/commands/speak.ts#L150).

**The issue.** `IsComponentsV2` changes how Discord interprets the message body:
a V2 message may not carry `content` or `embeds`. Applying that flag on an *edit*
of a message that was deferred without it is not clearly supported, and I did not
verify it against the live API — the boot test never reached a real interaction.
If Discord rejects it, these commands fail at the point of replying, which is
the worst place to find out.

Compounding it: the error paths in [speak.ts](src/commands/speak.ts) call
`editReply({ content: describeFailure(err) })` — plain content on an interaction
that may have already been flagged V2. If the flag stuck, the content edit is
invalid; if it did not, the success path was wrong. One of the two is broken.

**Proposed solution.** Verify against the live API before trusting either path,
then make it consistent: set the flag at defer time, and keep every subsequent
edit V2-shaped (wrap error text in a `container()` rather than passing `content`).

This is the one finding I would not fix blind — it needs a live interaction to
confirm which behaviour is real.

**Complexity** Small once verified.
**Risks** Currently unknown-broken, which is worse than known-broken.

---

## 13. Dead code and never-populated fields — Medium

All verified by grep:

| Symbol | Status |
| --- | --- |
| `estimateDurationMs` ([audio.ts:158](src/voice/audio.ts#L158)) | Defined, never called |
| `memberDisplayName` ([speak.ts:211](src/commands/speak.ts#L211)) | Defined, never called |
| `keysUsed` ([ttsService.ts:44](src/voice/ttsService.ts#L44)) | Computed and returned, never read by any caller |
| `estimatedQuotaRemaining` ([keyPool.ts:361](src/nim/keyPool.ts#L361)) | Hardcoded `null` |
| `rateLimitHits` ([keyPool.ts:283](src/nim/keyPool.ts#L283)) | Incremented, never exposed in `stats()` |

The last two are the interesting ones. `rateLimitHits` is tracked correctly but
never surfaced, which is why `api_usage.rate_limited` is written as a hardcoded
zero in [maintenance.ts](src/jobs/maintenance.ts) with a comment explaining the
value is unavailable — it is available, just not plumbed through. That is a
five-line fix that turns a dead analytics column into a real one, and it is
directly relevant to the project's core problem of avoiding rate limits.

`estimatedQuotaRemaining` should either be implemented (derive from observed
429 spacing) or deleted from `KeyStats`. A permanently-null field in a public
type is a promise the code does not keep.

**Proposed solution.** Delete the two unused functions and the `keysUsed` field.
Plumb `rateLimitHits` into `stats()`. Decide on `estimatedQuotaRemaining`.

**Complexity** Small.

---

## 14. `NIM_SAMPLE_RATE_HZ` must not be configurable — Medium

**Current implementation.** Exposed in config and `.env.example`, defaulting to
22050.

**The issue.** Magpie emits 22.05 kHz. It is a property of the model, not a
tunable. Setting it to 48000 does not produce better audio — it produces either
an API rejection or, worse, correctly-sized buffers interpreted at the wrong
rate, giving chipmunk audio with no error anywhere. The name invites exactly
that experiment.

It is also part of the cache key, so changing it silently invalidates the entire
cache.

**Proposed solution.** Move it to a `const MAGPIE_SAMPLE_RATE_HZ = 22_050` in
[voices.ts](src/nim/voices.ts) next to the rest of the model's facts, and drop it
from the environment. If self-hosting later exposes other rates, reintroduce it
as a per-model property rather than a global.

**Complexity** XS.
**Breaking changes** Removes an env var. Harmless — no correct value other than
the default exists.

---

## 15. Read-modify-write races on preferences — Low

`updateUser` ([userRepository.ts:98](src/database/repositories/userRepository.ts#L98))
reads the cached row, merges, and upserts the whole row. Two rapid `/voice`
select-menu interactions can interleave such that the second write is built from
a snapshot taken before the first landed, losing it.

Low severity because the window is milliseconds and the affected data is user
preferences, not anything of consequence. The fix — send only changed columns
rather than the merged row — is small and worth doing opportunistically:

```ts
await db().from(TABLE).update(changes).eq('id', userId);
```

This also stops every preference tweak from rewriting all sixteen columns.

---

## 16. Duplicate import — Low

[interactionCreate.ts:15-16](src/events/interactionCreate.ts#L15) imports from
`userRepository.js` twice. Cosmetic; ESLint would catch it with
`no-duplicate-imports` enabled. Worth enabling the rule rather than just fixing
the instance.

---

# Section-by-section assessment

## Architecture

**Verdict: sound. Do not restructure.**

The layering is correct and consistent: commands and events depend on services,
services depend on repositories and the NIM client, and nothing depends upward.
The composition root in [src/core/context.ts](src/core/context.ts) constructs
everything once and passes `BotContext` explicitly — this is real dependency
injection without a container, which is the right weight for a project this size.
Introducing InversifyJS or similar would be over-engineering.

`KeyPool` being transport-agnostic is the strongest decision in the codebase. It
knows nothing about gRPC, which is why it is the only component with meaningful
unit tests — that is not a coincidence, and it is the pattern to copy elsewhere.

**No circular dependencies.** The import graph is a DAG; `commands/index.ts`
aggregates and `events/` consumes.

**Genuine coupling issues, both minor:**

1. Repositories are module-level singletons with module-level caches, while
   everything else is instance-based and injected. This is why `TtsService`
   cannot be unit-tested without a live Supabase — it imports `logUsage` and
   `recordHistory` directly rather than receiving them. Converting the
   repositories to injected classes would make the service layer testable. This
   is the one architectural change I would actually endorse, and it can be done
   incrementally, one repository at a time.

2. `interactionCreate.ts` imports `describeFailure` from `commands/speak.ts`,
   so an event handler depends on a command module for error formatting. Move
   `describeFailure` to `src/utils/errors.ts`.

**SOLID:** no significant violations. `VoiceSession` is the closest thing to an
SRP concern (connection lifecycle + queue + playback in one class), but splitting
it would add indirection without reducing complexity — the three concerns are
genuinely coupled through Discord's connection model.

## NVIDIA NIM layer

The retry/failover model is correct and well-tested. Notable strengths worth
preserving: per-call metadata over a single shared channel, the distinction
between "cool this key" and "disable this key", and the decision that a 400 does
not penalise the key.

**Gaps, in priority order:**

- **Request collapsing** — finding #7. This is the highest-value NIM improvement.
- **No background health probes.** A key that is cooling is only re-tested when a
  real user request happens to select it, so the first request after recovery is
  a user's. A periodic probe on cooling/open keys would make recovery invisible.
  Cheap to add to the maintenance job.
- **No retry budget.** `maxRetries` is per-request. Under a broad NVIDIA outage
  every request burns its full retry allowance against every key, amplifying load
  at exactly the wrong moment. A global token-bucket retry budget (e.g. retries
  capped at 10% of total requests) is the standard fix.
- **`lowest-latency` is naive.** Sorting by EMA with unmeasured keys first means
  a key that got one lucky fast response gets preferred indefinitely. Consider
  latency-weighted random rather than strict argmin, so exploration continues.
- **`SynthesizeOnline` is declared in the proto and never used.** Streaming
  synthesis is the path to real time-to-first-word improvement, and combined with
  lazy queue synthesis (#4) it would let audio start before generation finishes.
  This is the largest remaining latency win available.

## Audio pipeline

Findings #1, #2 and #9 are all here, and together they are the weakest part of
the codebase. Beyond those:

- `atempoChain` is correct, including the ≤0.5 and ≥2.0 decomposition. Good.
- The pitch implementation (`asetrate` + `aresample` + compensating `atempo`) is
  the standard approach and correctly documented as such.
- Filter order is right: pitch before speed before volume.
- **One process per queue item** is a lot of spawn overhead (~20–40 ms each) for
  short clips. For the common case — no pitch shift, no speed change, volume 1.0,
  and the only work being 22.05→48 kHz stereo conversion — you could skip ffmpeg
  entirely and resample in JS, or keep a warm ffmpeg process. Worth measuring
  before optimising, but the common case is likely 80%+ of traffic.

## Discord layer

- Command surface is coherent; the moderator-vs-self permission split on
  playback control is well judged.
- The voice picker reading state from the database rather than memory is the
  right call and genuinely survives restarts.
- **Missing:** modals (the brief asked for them; a bulk pronunciation-import
  modal is the obvious fit), pagination (`/history` and `/favorites` truncate at
  15 and 40 with no way to see more), and context menus.
- **`/queue` truncates at 10** with no pagination.
- Autocomplete exists only on `/favorites remove`. `/voice` would benefit if the
  catalogue grows.

## Database

Schema is well-normalised with appropriate indexes and correct snowflake-as-TEXT
handling. RLS-enabled-with-no-policies is the correct posture for a service_role
backend and is properly explained in the migration.

**Gaps:**

- No retention (#8).
- `analytics_daily` and `sessions` are defined but **never written to** by any
  code path. Either wire them up or drop them — an empty table that looks
  populated is a trap for whoever builds the dashboard.
- `guild_ignores` has no FK to a guild that may not exist yet — fine in practice
  given the upsert order, but worth an explicit `on delete cascade` review.
- Consider a partial index on `usage_logs (created_at) where success = false`;
  failure queries are the common diagnostic path.

## Security

The fundamentals are right: secrets only from env, redaction at the pino
serialiser (not per call site), parameterised queries throughout via the
Supabase client, no shell interpolation anywhere — `spawn` is called with an
argument array, so the ffmpeg path is not command-injectable even though it
handles user-influenced numbers.

Two things to note:

- **`volume.toFixed(2)` and friends are interpolated into the filter graph**
  ([audio.ts:96](src/voice/audio.ts#L96)). They are numbers validated by zod and
  clamped by DB constraints, so this is safe *today*. It is safe by accident of
  two layers rather than by construction. An explicit clamp at the point of use
  would make it safe by design.
- **The service_role key bypasses RLS.** Correct for this design, but it means
  any code path that ever accepts a user-supplied table or column name would be
  a full compromise. None currently does. Keep it that way.

## Observability

Structured logging with request IDs is in place and correct. What is missing for
production operation:

- **No metrics endpoint.** `/status` is excellent for a human in Discord but
  useless to Prometheus. A `/metrics` HTTP endpoint exposing the same pool stats
  is maybe 40 lines and unlocks alerting.
- **No health endpoint** for container orchestration — Docker has no
  `HEALTHCHECK`, so a wedged bot looks healthy to the scheduler.
- Request IDs exist but do not propagate into the queue or playback stage, so a
  slow message cannot be traced end to end.

## Testing

27 tests, all on `KeyPool` and `text` — the two pure-logic modules. Those are
well covered, including the regression test for the discovery bug.

**Untested:** everything with I/O. Specifically worth adding, in order of value:

1. `AudioCache` — pure filesystem, easily tested with a temp dir. Currently zero
   coverage on the eviction and prune paths, which is where cache bugs live.
2. `TtsService` — needs the repository injection change above to be testable.
3. `buildFilterGraph` — pure function, trivially testable, currently untested
   despite being the thing that produced finding #2.
4. `VoiceSession` queue ordering — priority band behaviour is pure logic once the
   Discord connection is faked.

No integration or load testing exists. Given the memory findings, a soak test
(sustained synthesis for an hour, watching RSS) would have caught #1 and #3 and
is worth more than additional unit tests.

## Scalability estimate

Grounded in the findings above rather than guessed:

- **100 guilds** — fine as-is. The leaks are slow enough that daily restarts hide
  them.
- **1,000 guilds** — findings #1, #3 and #4 become the binding constraint. Expect
  OOM/PID exhaustion within hours to days. Fix those and this tier is
  comfortable on one process.
- **10,000 guilds** — exceeds one gateway process; requires sharding, which
  surfaces #10 (blacklist drift) and makes the module-level caches per-shard.
  Supabase write volume from #8 becomes the next wall.
- **100,000 guilds** — requires a different architecture: separate gateway
  workers from a synthesis service, shared Redis cache instead of per-process
  memory, and the audio cache on object storage rather than local disk. Also
  well beyond what NVIDIA's hosted endpoints permit — see the licensing note in
  [NIM-LIMITATIONS.md](NIM-LIMITATIONS.md), which is the real ceiling here, not
  the code.

---

# Roadmap

## Critical — before any production traffic

1. Kill ffmpeg processes (#1)
2. Fix the `areverse` buffering (#2)
3. Bound the four repository caches (#3)
4. Verify the Components V2 `editReply` behaviour (#12) — unknown-broken
5. Add retention to `usage_logs` / `voice_history` (#8)

Items 1–3 are each under an hour and are the difference between an instance that
survives a week and one that does not.

## High — materially better stability and latency

6. Per-user queue cap, then lazy queue synthesis (#4)
7. Parallel chunk synthesis (#6)
8. In-flight request collapsing (#7)
9. Byte-bounded memory cache (#9)
10. Fix the preference-override bug (#5)
11. Plumb `rateLimitHits` into stats (#13)
12. Background health probes for cooling keys
13. Retry budget

## Medium — quality of life

14. `ephemeral` → `MessageFlags.Ephemeral` (#11)
15. Delete dead code; resolve `estimatedQuotaRemaining` (#13)
16. Make sample rate a model constant (#14)
17. Inject repositories so `TtsService` is testable
18. Move `describeFailure` out of the command module
19. Tests for `AudioCache` and `buildFilterGraph`
20. Pagination for `/history`, `/favorites`, `/queue`
21. `/metrics` endpoint and a Docker `HEALTHCHECK`
22. Periodic blacklist reload (#10)

## Low

23. Partial-column updates (#15)
24. Duplicate import + enable `no-duplicate-imports` (#16)
25. Warm ffmpeg process or JS resampling for the no-shaping common case
26. Modals for bulk pronunciation import
27. Wire up `analytics_daily` and `sessions`, or drop them

## Future vision

- **`SynthesizeOnline` streaming** — the largest remaining latency win, and it
  pairs naturally with lazy queue synthesis.
- **Shared cache tier (Redis / object storage)** — prerequisite for sharding, and
  it multiplies cache hit rate across shards rather than fragmenting it.
- **Separate synthesis service** — decouples CPU-bound audio work from the
  gateway, letting each scale independently.
- **Self-hosted NIM** — resolves the licensing ceiling *and* the rate limits in
  one move, and makes the whole five-key balancer optional. Worth evaluating
  before investing further in quota-avoidance engineering.
- **Web dashboard** — the schema already anticipates it; note it will need real
  RLS policies, since the current posture assumes service_role is the only
  client.

---

## Closing note

Two of the three critical findings (#1, #2) and one high (#9) are in the audio
pipeline, and all three share a cause: the module was written to a streaming
design that the filter graph and process handling do not actually implement. If
you fix nothing else first, fix [src/voice/audio.ts](src/voice/audio.ts) — and
add tests for `buildFilterGraph` while you are in there, since it is a pure
function that would have made the buffering problem visible immediately.
