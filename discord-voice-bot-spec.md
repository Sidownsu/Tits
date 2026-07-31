# Project Spec: Discord Text-to-Voice Bot

## What this bot does
A Discord bot that joins a voice channel and speaks aloud whatever users type in a
designated text channel. Built for users who can't or don't want to talk in VC
(shy, new to server, language barrier, etc.) — they type, the bot speaks it in VC.

**Core flow:**
1. User runs `/join` (or similar) in a server.
2. Bot joins the target voice channel (e.g. "Lobby 1").
3. Anyone types in the linked text channel for that VC.
4. Bot converts that text to speech and plays it in the voice channel.

## Feature roadmap

### V1 (build and ship first — all free-tier friendly)
- Core join/leave/read pipeline (text channel → speech → VC).
- Per-user saved preferences, stored in a small database:
  - Voice gender (male/female)
  - Spoken language
  - Accent (e.g. British / Indian / Australian / American English) — this is just
    picking a different prebuilt voice ID from the TTS provider's catalog, not a
    separate technical system. No extra engineering vs. gender/language selection.
  - Users can change these anytime via a settings command.
- All of this is achievable using free/low-cost TTS APIs with prebuilt voices —
  no training, no cloning, no ML work required for V1.

### V2 (separate, paid, later — do not build until V1 is validated and used)
- **Voice cloning**: user records ~1–2 minutes of their voice, bot creates a
  synthetic version of their actual voice that can speak arbitrary text.
  - Solved problem commercially (e.g. ElevenLabs Instant Voice Cloning), not R&D.
  - **Not free at real usage volume.** Free tier is ~10 min of generated audio/month
    across the whole account and blocked from commercial/server use — fine for
    prototyping, not for a live server with multiple active users. Paid tiers start
    around $5/mo (basic cloning) up to $22/mo (higher-quality "professional" cloning).
    Budget for this and/or cap usage per user before turning it on for others.
- **Accent conversion on a cloned voice** (keep the person's actual voice identity,
  but change/neutralize their accent): this is a *different and harder* problem than
  cloning, not an extra "level" on top of it. Accent is baked into the same audio as
  timbre — a clone trained on someone's voice inherits their accent by default.
  Disentangling "whose voice is this" from "what accent are they speaking with" needs
  a separate, more specialized model/service (this space exists — e.g. Sanas.ai does
  real-time accent conversion commercially — but it's not a checkbox in standard TTS
  APIs). Treat this as its own R&D-flavored sub-project, not a natural V1→V2→V3 step.

## Recommended stack

- **Language: Python** (`py-cord` or `discord.py`).
  Note: language choice does NOT affect audio quality — that comes entirely from
  whichever TTS API is called. Python is recommended because if V2 (cloning /
  accent work) ever happens, that ecosystem (PyTorch, RVC, so-vits-svc, etc.) is
  Python-native, so there's no rewrite later.
- **Voice piping into Discord VC**: `ffmpeg` + `PyNaCl`. Required either way.
- **TTS engine**:
  - Prototype/V1 with **`edge-tts`** — free, no API key required, decent multilingual
    and accent voice coverage (uses Microsoft Edge's voices). Good enough to fully
    build and test V1 without spending anything.
  - Move to **ElevenLabs** only when better quality is needed or when starting V2
    (cloning). Don't pay for it until past the prototyping stage.
- **Database**: Supabase free tier. Storage need is tiny (per-user: user_id, voice
  gender, language, accent/voice_id) — free tier is more than sufficient for this.
  (If V2 cloning is added, recorded voice samples may need actual file storage —
  check Supabase storage limits at that point, since audio files are bigger than
  preference rows.)

## Build order suggestion
1. Basic bot: `/join`, reads text channel aloud in VC, using `edge-tts` with one
   default voice. Get this working end-to-end first.
2. Add per-user prefs (gender/language/accent) + Supabase persistence + settings command.
3. Ship V1, let people actually use it.
4. Only after real usage: evaluate whether voice cloning (V2) is worth the cost,
   decide how to fund/cap it, then build it as its own phase.
5. Accent-conversion-on-cloned-voice is a separate future exploration, not part of
   the V1/V2 timeline above.
