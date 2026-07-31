# NVIDIA NIM: what it can and cannot do for this bot

Read this before promising anyone a feature. Everything here is a property of
the upstream service, not of this codebase, and no amount of application code
works around it.

## Voice catalogue

The original brief asked for 23 voice personas (Anime, Robot, Narrator, Podcast,
Streamer, Whisper, …) across 30 accents. **Magpie TTS Multilingual does not have
those.** What it has:

| Axis | Reality |
| --- | --- |
| Locales | 12 — `EN-US`, `ES-US`, `FR-FR`, `DE-DE`, `ZH-CN`, `VI-VN`, `IT-IT`, `HI-IN`, `JA-JP`, `KO-KR`, `AR-AR`, `PT-BR` |
| Speakers | 13 named voices, **not** available in every locale |
| Styles | 7 emotions — Neutral, Calm, Happy, Sad, Angry, Fearful, PleasantSurprised — and only on *some* speaker/locale pairs |

Voice names look like `Magpie-Multilingual.EN-US.Aria.Happy`.

**Not available at all:** British, Australian, Irish, Scottish, New Zealand or
South African English; Tamil, Telugu, Bengali, Urdu, Russian, Turkish, Thai,
Indonesian, Polish, Dutch. There is no "child voice", "robot voice" or
"narrator" — those are persona concepts this model does not expose.

Because the speaker roster per locale is not fully documented, `src/nim/voices.ts`
ships a small verified seed and calls `GetRivaSynthesisConfig` at boot to replace
it with whatever the live service reports. `/voice` only ever offers combinations
that actually exist, so the UI cannot drift from the model.

## Request shape

- **20 seconds of audio per request.** Long messages are split on sentence
  boundaries by `chunkForSynthesis()` and the PCM is concatenated. Each chunk is
  cached separately, so repeated sentences get partial cache hits.
- **22.05 kHz output.** Discord wants 48 kHz stereo; ffmpeg resamples.
- **No rate, pitch or volume parameters.** Magpie has no equivalent of SSML
  prosody controls. This bot implements speed/pitch/volume in ffmpeg after
  synthesis (`src/voice/audio.ts`). Pitch shifting is resample-plus-atempo, which
  is a genuine shift but is not the same thing as a model that renders the voice
  at a different pitch — extreme values will sound processed.
- **No SSML.** The brief listed "SSML support if available". It is not available
  on this path.

## Transport

The hosted endpoint is **gRPC, not REST**: `grpc.nvcf.nvidia.com:443`, with the
API key in an `authorization: Bearer` metadata header and a `function-id` header
naming the model. There is no JSON HTTP endpoint for Magpie TTS.

NVIDIA ships official Riva clients for **Python and C++ only**. There is no
official Node client, so `src/nim/client.ts` drives the service directly with
`@grpc/grpc-js` against the Riva protos. A trimmed proto covering the three RPCs
this bot uses is bundled; `npm run fetch-protos` vendors the canonical upstream
files if you would rather track those.

## Licensing — read this one

NVIDIA's hosted `build.nvidia.com` endpoints are documented for **prototyping and
development**. Serving real end users is "production" under NVIDIA's terms and
requires an **NVIDIA AI Enterprise licence**.

The five-key rotation in this codebase is genuinely useful engineering — it
survives transient 429s and 5xx, fails over instantly, and keeps the bot audible
when one key dies. But if the reason for five keys is to multiply a free
prototyping quota into production capacity, that is working around a licensing
boundary rather than a technical one, and NVIDIA can close it at any time by
rate-limiting per account rather than per key. There are reports of exactly that
already happening.

Two honest paths to production:

1. **Licence it.** Get NVIDIA AI Enterprise, or self-host the TTS NIM container
   on your own GPU. Self-hosting removes the rate limits and the licensing
   question in one move; the same gRPC client works against `localhost:50051`.
2. **Use a provider whose free tier permits this.** The Python prototype in this
   repo's history used `edge-tts`, which is free, needs no key, and covers *more*
   languages and accents than Magpie does. It is a worse-sounding model but a
   cleaner legal position.

## Sources

- [Voices and emotional styles](https://docs.nvidia.com/nim/speech/latest/tts/voices.html)
- [TTS support matrix](https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/tts.html)
- [TTS quickstart](https://docs.nvidia.com/nim/speech/latest/get-started/tutorials/tts.html)
- [Speech NIM overview](https://docs.nvidia.com/nim/speech/latest/index.html)
