import edge_tts

DEFAULT_VOICE = "en-US-AriaNeural"


async def stream_mp3(text: str, voice: str = DEFAULT_VOICE,
                     rate: str = "+0%", pitch: str = "+0Hz"):
    """Yield MP3 audio chunks from edge-tts as soon as they arrive."""
    communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate, pitch=pitch)
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            yield chunk["data"]


async def synthesize_to_bytes(text: str, voice: str = DEFAULT_VOICE,
                              rate: str = "+0%", pitch: str = "+0Hz") -> bytes:
    """Synthesize `text` and return the full MP3 as bytes (used for DM previews)."""
    buf = bytearray()
    async for chunk in stream_mp3(text, voice, rate, pitch):
        buf.extend(chunk)
    return bytes(buf)


async def list_voices():
    return await edge_tts.list_voices()
