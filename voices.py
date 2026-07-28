"""Voice catalog + preference resolution.

Rate, pitch and volume are stored as integer "steps" so each button click on the
UI moves the value by exactly one step.

  - rate_step:   -10..+10  (5% per step)     -> -50%..+50%
  - pitch_step:  -10..+10  (10Hz per step)   -> -100Hz..+100Hz
  - volume_step:   0..+20  (10% per step)    -> 0%..200%; 10 = normal (100%)
"""

# (gender, language, accent) -> edge-tts voice id
_VOICE_MAP: dict[tuple[str, str, str], str] = {
    ("female", "en", "US"): "en-US-AriaNeural",
    ("male",   "en", "US"): "en-US-GuyNeural",
    ("female", "en", "GB"): "en-GB-SoniaNeural",
    ("male",   "en", "GB"): "en-GB-RyanNeural",
    ("female", "en", "AU"): "en-AU-NatashaNeural",
    ("male",   "en", "AU"): "en-AU-WilliamNeural",
    ("female", "en", "IN"): "en-IN-NeerjaNeural",
    ("male",   "en", "IN"): "en-IN-PrabhatNeural",
    ("female", "es", "ES"): "es-ES-ElviraNeural",
    ("male",   "es", "ES"): "es-ES-AlvaroNeural",
    ("female", "fr", "FR"): "fr-FR-DeniseNeural",
    ("male",   "fr", "FR"): "fr-FR-HenriNeural",
    ("female", "de", "DE"): "de-DE-KatjaNeural",
    ("male",   "de", "DE"): "de-DE-ConradNeural",
    ("female", "hi", "IN"): "hi-IN-SwaraNeural",
    ("male",   "hi", "IN"): "hi-IN-MadhurNeural",
    ("female", "ja", "JP"): "ja-JP-NanamiNeural",
    ("male",   "ja", "JP"): "ja-JP-KeitaNeural",
    ("female", "pt", "BR"): "pt-BR-FranciscaNeural",
    ("male",   "pt", "BR"): "pt-BR-AntonioNeural",
}

_LANG_DEFAULT_ACCENT = {
    "en": "US", "es": "ES", "fr": "FR", "de": "DE",
    "hi": "IN", "ja": "JP", "pt": "BR",
}

# Voice characters — alternative voice personalities (English only).
# character_id -> (label, description, {gender: voice_id})
_CHARACTERS: dict[str, tuple[str, str, dict[str, str]]] = {
    "standard":  ("Standard",    "Default balanced voice",       {"female": None, "male": None}),
    "cute":      ("Cute",        "Cartoon child-like voice",     {"female": "en-US-AnaNeural",      "male": "en-US-AnaNeural"}),
    "warm":      ("Warm",        "Caring and expressive",        {"female": "en-US-AvaNeural",      "male": "en-US-AndrewNeural"}),
    "cheerful":  ("Cheerful",    "Upbeat and conversational",    {"female": "en-US-EmmaNeural",     "male": "en-US-BrianNeural"}),
    "serious":   ("Serious",     "Authoritative newscaster",     {"female": "en-US-MichelleNeural", "male": "en-US-ChristopherNeural"}),
    "lively":    ("Lively",      "Energetic and passionate",     {"female": "en-US-JennyNeural",    "male": "en-US-RogerNeural"}),
}

CHARACTER_CHOICES = [
    ("Standard",  "standard"),
    ("Cute",      "cute"),
    ("Warm",      "warm"),
    ("Cheerful",  "cheerful"),
    ("Serious",   "serious"),
    ("Lively",    "lively"),
]

# Step ranges.
RATE_MIN,   RATE_MAX,   RATE_PCT   = -10, 10, 5      # ±50% in 5% steps
PITCH_MIN,  PITCH_MAX,  PITCH_HZ   = -10, 10, 10     # ±100Hz in 10Hz steps
VOL_MIN,    VOL_MAX,    VOL_PCT    = 0,  20, 10      # 0..200% in 10% steps
VOL_DEFAULT = 10                                     # 100% = normal

DEFAULT_PREFS = {
    "gender":      "female",
    "language":    "en",
    "accent":      "US",
    "character":   "standard",
    "rate_step":   0,
    "pitch_step":  0,
    "volume_step": VOL_DEFAULT,
}

GENDER_CHOICES = [("Female", "female"), ("Male", "male")]
LANGUAGE_CHOICES = [
    ("English", "en"), ("Spanish", "es"), ("French", "fr"),
    ("German", "de"),  ("Hindi", "hi"),   ("Japanese", "ja"),
    ("Portuguese (Brazil)", "pt"),
]
ACCENT_CHOICES = [
    ("American (US)", "US"),
    ("British (GB)", "GB"),
    ("Australian (AU)", "AU"),
    ("Indian (IN)", "IN"),
]


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def clamp_rate(s):   return _clamp(s, RATE_MIN,  RATE_MAX)
def clamp_pitch(s):  return _clamp(s, PITCH_MIN, PITCH_MAX)
def clamp_volume(s): return _clamp(s, VOL_MIN,   VOL_MAX)


def resolve_voice(gender: str, language: str, accent: str,
                  character: str = "standard") -> str:
    if character != "standard" and language == "en":
        char = _CHARACTERS.get(character)
        if char:
            voice_id = char[2].get(gender)
            if voice_id:
                return voice_id
    key = (gender, language, accent)
    if key in _VOICE_MAP:
        return _VOICE_MAP[key]
    fallback = (gender, language, _LANG_DEFAULT_ACCENT.get(language, "US"))
    if fallback in _VOICE_MAP:
        return _VOICE_MAP[fallback]
    return _VOICE_MAP[("female", "en", "US")]


def rate_ssml(step: int) -> str:
    pct = clamp_rate(step) * RATE_PCT
    return f"{'+' if pct >= 0 else ''}{pct}%"


def pitch_ssml(step: int) -> str:
    hz = clamp_pitch(step) * PITCH_HZ
    return f"{'+' if hz >= 0 else ''}{hz}Hz"


def volume_scale(step: int) -> float:
    return clamp_volume(step) * VOL_PCT / 100.0


def rate_display(step: int) -> str:
    pct = clamp_rate(step) * RATE_PCT
    return f"{'+' if pct >= 0 else ''}{pct}%"


def pitch_display(step: int) -> str:
    hz = clamp_pitch(step) * PITCH_HZ
    return f"{'+' if hz >= 0 else ''}{hz} Hz"


def volume_display(step: int) -> str:
    return f"{clamp_volume(step) * VOL_PCT}%"


def _label_for(pairs, value):
    return next((label for label, v in pairs if v == value), value)


def gender_label(v):    return _label_for(GENDER_CHOICES,    v)
def language_label(v):  return _label_for(LANGUAGE_CHOICES,  v)
def accent_label(v):    return _label_for(ACCENT_CHOICES,    v)
def character_label(v): return _label_for(CHARACTER_CHOICES, v)


def character_description(v: str) -> str:
    char = _CHARACTERS.get(v)
    return char[1] if char else ""


def render_marker_bar(step: int, lo: int, hi: int, left: str, right: str) -> str:
    width = hi - lo
    pos = _clamp(step, lo, hi) - lo
    chars = ["░"] * (width + 1)
    chars[pos] = "█"
    return f"{left} {''.join(chars)} {right}"


def render_fill_bar(step: int, lo: int, hi: int, left: str, right: str) -> str:
    width = hi - lo
    pos = _clamp(step, lo, hi) - lo
    return f"{left} {'█' * pos}{'░' * (width - pos)} {right}"
