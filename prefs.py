"""Supabase-backed per-user voice preferences with an in-memory cache."""
import os
import asyncio
from supabase import create_client, Client

from voices import DEFAULT_PREFS

_TABLE = "user_voice_prefs"

_client: Client | None = None
_cache: dict[int, dict] = {}


def _get_client() -> Client:
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_KEY"]
        _client = create_client(url, key)
    return _client


async def get_prefs(user_id: int) -> dict:
    """Return this user's prefs, filling in defaults for any missing fields."""
    if user_id in _cache:
        return _cache[user_id]

    def _fetch():
        return (
            _get_client()
            .table(_TABLE)
            .select("*")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )

    resp = await asyncio.to_thread(_fetch)
    row = resp.data if resp else None
    prefs = {**DEFAULT_PREFS, **(row or {})}
    _cache[user_id] = prefs
    return prefs


async def update_prefs(user_id: int, changes: dict) -> dict:
    """Merge `changes` into the user's row and return the full new prefs."""
    current = await get_prefs(user_id)
    merged = {**current, **{k: v for k, v in changes.items() if v is not None}}
    payload = {"user_id": user_id, **{k: merged[k] for k in DEFAULT_PREFS}}

    def _write():
        return (
            _get_client()
            .table(_TABLE)
            .upsert(payload, on_conflict="user_id")
            .execute()
        )

    await asyncio.to_thread(_write)
    _cache[user_id] = merged
    return merged
