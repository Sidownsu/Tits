import asyncio
import io
import os
import subprocess
from collections import defaultdict

import discord
from discord.ext import commands
from dotenv import load_dotenv

from tts import stream_mp3, synthesize_to_bytes
from voices import (
    ACCENT_CHOICES, CHARACTER_CHOICES, DEFAULT_PREFS,
    GENDER_CHOICES, LANGUAGE_CHOICES,
    PITCH_MAX, PITCH_MIN, RATE_MAX, RATE_MIN, VOL_MAX, VOL_MIN,
    accent_label, character_label, character_description,
    clamp_pitch, clamp_rate, clamp_volume,
    gender_label, language_label, pitch_display, pitch_ssml,
    rate_display, rate_ssml, render_fill_bar, render_marker_bar,
    resolve_voice, volume_display, volume_scale,
)
from prefs import get_prefs, update_prefs

load_dotenv()
TOKEN = os.getenv("DISCORD_TOKEN")
FFMPEG_PATH = os.getenv("FFMPEG_PATH") or "ffmpeg"
_debug_guild = os.getenv("DEBUG_GUILD_ID")
DEBUG_GUILDS = [int(_debug_guild)] if _debug_guild and _debug_guild.isdigit() else None

intents = discord.Intents.default()
intents.message_content = True
intents.voice_states = True

bot = commands.Bot(intents=intents, debug_guilds=DEBUG_GUILDS)

linked_text_channel: dict[int, int] = {}
speak_queues: dict[int, asyncio.Queue] = defaultdict(asyncio.Queue)
player_tasks: dict[int, asyncio.Task] = {}


# ---------------------------------------------------------------------------
# Playback (edge-tts MP3 -> ffmpeg [+ volume filter] -> PCM -> Discord)
# ---------------------------------------------------------------------------

def _spawn_ffmpeg(vol: float) -> subprocess.Popen:
    args = [FFMPEG_PATH, "-loglevel", "quiet", "-i", "pipe:0"]
    if abs(vol - 1.0) > 0.001:
        args += ["-af", f"volume={vol:.2f}"]
    args += ["-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"]
    return subprocess.Popen(
        args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, bufsize=0,
    )


def _prep(text: str, voice: str, rate: str, pitch: str, vol: float) -> tuple[subprocess.Popen, asyncio.Task]:
    proc = _spawn_ffmpeg(vol)

    async def _feed():
        try:
            async for chunk in stream_mp3(text, voice, rate, pitch):
                await asyncio.to_thread(proc.stdin.write, chunk)
        except Exception as e:
            print(f"[player] tts stream error: {e}")
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    return proc, asyncio.create_task(_feed())


async def _teardown(proc: subprocess.Popen, feeder: asyncio.Task) -> None:
    try:
        await feeder
    except Exception:
        pass
    try:
        proc.terminate()
    except Exception:
        pass
    try:
        await asyncio.to_thread(proc.wait, 1)
    except Exception:
        pass


async def player_loop(guild: discord.Guild):
    queue = speak_queues[guild.id]
    pending: tuple[subprocess.Popen, asyncio.Task] | None = None

    while True:
        if pending is not None:
            proc, feeder = pending
            pending = None
        else:
            item = await queue.get()
            queue.task_done()
            proc, feeder = _prep(*item)

        vc = guild.voice_client
        if vc is None or not vc.is_connected():
            await _teardown(proc, feeder)
            continue

        done = asyncio.Event()

        def _after(err):
            if err:
                print(f"[player] playback error: {err}")
            bot.loop.call_soon_threadsafe(done.set)

        try:
            source = discord.PCMAudio(proc.stdout)
            vc.play(source, after=_after)
        except Exception as e:
            print(f"[player] error: {e}")
            await _teardown(proc, feeder)
            continue

        done_task = asyncio.create_task(done.wait())
        next_get = asyncio.create_task(queue.get())
        finished, _ = await asyncio.wait(
            {done_task, next_get}, return_when=asyncio.FIRST_COMPLETED
        )

        if next_get in finished:
            item2 = next_get.result()
            queue.task_done()
            pending = _prep(*item2)
            await done_task
        else:
            next_get.cancel()
            try:
                await next_get
            except (asyncio.CancelledError, Exception):
                pass

        await _teardown(proc, feeder)


def ensure_player(guild: discord.Guild):
    task = player_tasks.get(guild.id)
    if task is None or task.done():
        player_tasks[guild.id] = bot.loop.create_task(player_loop(guild))


# ---------------------------------------------------------------------------
# /join, /leave, on_message
# ---------------------------------------------------------------------------

@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} (id={bot.user.id})")


@bot.slash_command(description="Join your current voice channel and read this text channel aloud.")
async def join(ctx: discord.ApplicationContext):
    if ctx.author.voice is None or ctx.author.voice.channel is None:
        await ctx.respond("You need to be in a voice channel first.", ephemeral=True)
        return
    await ctx.defer()
    vc_channel = ctx.author.voice.channel
    if ctx.guild.voice_client is None:
        await vc_channel.connect()
    else:
        await ctx.guild.voice_client.move_to(vc_channel)
    linked_text_channel[ctx.guild.id] = ctx.channel.id
    ensure_player(ctx.guild)
    await ctx.followup.send(
        f"Joined **{vc_channel.name}**. Reading messages from {ctx.channel.mention}."
    )


@bot.slash_command(description="Leave the voice channel.")
async def leave(ctx: discord.ApplicationContext):
    if ctx.guild.voice_client is None:
        await ctx.respond("I'm not in a voice channel.", ephemeral=True)
        return
    await ctx.defer()
    await ctx.guild.voice_client.disconnect(force=False)
    linked_text_channel.pop(ctx.guild.id, None)
    task = player_tasks.pop(ctx.guild.id, None)
    if task and not task.done():
        task.cancel()
    await ctx.followup.send("Left the voice channel.")


@bot.event
async def on_message(message: discord.Message):
    if message.author.bot or message.guild is None:
        return
    if linked_text_channel.get(message.guild.id) != message.channel.id:
        return
    text = message.clean_content.strip()
    if not text:
        return
    if len(text) > 500:
        text = text[:500] + "..."

    prefs = await get_prefs(message.author.id)
    voice_id = resolve_voice(
        prefs["gender"], prefs["language"], prefs["accent"],
        prefs.get("character", "standard"),
    )
    await speak_queues[message.guild.id].put((
        text, voice_id,
        rate_ssml(prefs["rate_step"]),
        pitch_ssml(prefs["pitch_step"]),
        volume_scale(prefs["volume_step"]),
    ))


# ---------------------------------------------------------------------------
# /settings — redesigned UI
# ---------------------------------------------------------------------------

PREVIEW_TEXT = "Hello — this is what I sound like now."


def _voice_id(prefs: dict) -> str:
    return resolve_voice(
        prefs["gender"], prefs["language"], prefs["accent"],
        prefs.get("character", "standard"),
    )


def _tuning_hint(label: str, step: int, default: int) -> str:
    if step == default:
        return "normal"
    if label == "rate":
        return "faster" if step > 0 else "slower"
    if label == "pitch":
        return "higher" if step > 0 else "lower"
    if label == "volume":
        return "louder" if step > default else "quieter"
    return ""


async def _preview(interaction: discord.Interaction, prefs: dict):
    await interaction.response.defer(ephemeral=True, invisible=False)
    voice = _voice_id(prefs)
    try:
        mp3 = await synthesize_to_bytes(
            PREVIEW_TEXT, voice=voice,
            rate=rate_ssml(prefs["rate_step"]),
            pitch=pitch_ssml(prefs["pitch_step"]),
        )
        file = discord.File(io.BytesIO(mp3), filename="preview.mp3")
        await interaction.followup.send(
            f"🔊 Preview — `{voice}`",
            file=file, ephemeral=True,
        )
    except Exception as e:
        print(f"[settings] preview error: {e}")
        await interaction.followup.send("Couldn't generate preview.", ephemeral=True)


def _guard(owner_id: int):
    async def check(interaction: discord.Interaction) -> bool:
        if interaction.user.id != owner_id:
            await interaction.response.send_message(
                "Not your panel — run `/settings` for your own.", ephemeral=True,
            )
            return False
        return True
    return check


# ----- Main panel -----------------------------------------------------------

def _main_embed(prefs: dict) -> discord.Embed:
    voice = _voice_id(prefs)
    char = prefs.get("character", "standard")
    char_text = f" · {character_label(char)}" if char != "standard" else ""

    e = discord.Embed(color=0x5865F2)
    e.set_author(name="Your voice settings", icon_url=None)

    e.description = (
        f"```\n"
        f"{voice}\n"
        f"{gender_label(prefs['gender'])} · "
        f"{language_label(prefs['language'])} · "
        f"{accent_label(prefs['accent'])}"
        f"{char_text}\n"
        f"```"
    )

    rate_hint = _tuning_hint("rate", prefs["rate_step"], 0)
    pitch_hint = _tuning_hint("pitch", prefs["pitch_step"], 0)
    vol_hint = _tuning_hint("volume", prefs["volume_step"], 10)

    e.add_field(
        name="⚡ Rate",
        value=f"**{rate_display(prefs['rate_step'])}**\n{rate_hint}",
        inline=True,
    )
    e.add_field(
        name="🎵 Pitch",
        value=f"**{pitch_display(prefs['pitch_step'])}**\n{pitch_hint}",
        inline=True,
    )
    e.add_field(
        name="🔊 Volume",
        value=f"**{volume_display(prefs['volume_step'])}**\n{vol_hint}",
        inline=True,
    )

    e.set_footer(text="Tap a button to customize · changes save instantly")
    return e


def _main_view(user_id: int, prefs: dict) -> discord.ui.View:
    view = discord.ui.View(timeout=600)
    guard = _guard(user_id)

    def cat_button(label: str, emoji: str, factory, row: int):
        btn = discord.ui.Button(label=label, emoji=emoji,
                                style=discord.ButtonStyle.secondary, row=row)

        async def cb(interaction: discord.Interaction):
            if not await guard(interaction):
                return
            fresh = await get_prefs(user_id)
            embed, sub_view = factory(user_id, fresh)
            await interaction.response.edit_message(embed=embed, view=sub_view)

        btn.callback = cb
        return btn

    view.add_item(cat_button("Gender",    "👤", _gender_panel,    0))
    view.add_item(cat_button("Language",  "🌐", _language_panel,  0))
    view.add_item(cat_button("Accent",    "🗣️", _accent_panel,    0))
    view.add_item(cat_button("Character", "✨", _character_panel, 0))

    view.add_item(cat_button("Rate",   "⚡", _rate_panel,   1))
    view.add_item(cat_button("Pitch",  "🎵", _pitch_panel,  1))
    view.add_item(cat_button("Volume", "🔊", _volume_panel, 1))

    preview_btn = discord.ui.Button(label="Preview", emoji="🔊",
                                     style=discord.ButtonStyle.primary, row=2)

    async def on_preview(interaction: discord.Interaction):
        if not await guard(interaction):
            return
        fresh = await get_prefs(user_id)
        await _preview(interaction, fresh)

    preview_btn.callback = on_preview
    view.add_item(preview_btn)

    reset_btn = discord.ui.Button(label="Reset all", emoji="↩️",
                                   style=discord.ButtonStyle.danger, row=2)

    async def on_reset(interaction: discord.Interaction):
        if not await guard(interaction):
            return
        new_prefs = await update_prefs(user_id, DEFAULT_PREFS)
        await interaction.response.edit_message(
            embed=_main_embed(new_prefs), view=_main_view(user_id, new_prefs),
        )

    reset_btn.callback = on_reset
    view.add_item(reset_btn)

    return view


# ----- Shared sub-panel helpers --------------------------------------------

def _back_button(user_id: int, row: int) -> discord.ui.Button:
    btn = discord.ui.Button(label="Back",
                             style=discord.ButtonStyle.secondary, row=row)
    guard = _guard(user_id)

    async def cb(interaction: discord.Interaction):
        if not await guard(interaction):
            return
        fresh = await get_prefs(user_id)
        await interaction.response.edit_message(
            embed=_main_embed(fresh), view=_main_view(user_id, fresh),
        )

    btn.callback = cb
    return btn


def _preview_button(user_id: int, row: int) -> discord.ui.Button:
    btn = discord.ui.Button(label="Preview", emoji="🔊",
                             style=discord.ButtonStyle.primary, row=row)
    guard = _guard(user_id)

    async def cb(interaction: discord.Interaction):
        if not await guard(interaction):
            return
        fresh = await get_prefs(user_id)
        await _preview(interaction, fresh)

    btn.callback = cb
    return btn


# ----- Gender / Language / Accent sub-panels -------------------------------

def _choice_panel(title: str, emoji: str, field: str, choices: list[tuple[str, str]],
                  footer: str = ""):
    def factory(user_id: int, prefs: dict):
        current_label = _label_for_field(field, prefs[field])

        e = discord.Embed(color=0x5865F2)
        e.set_author(name=f"{emoji}  {title}")
        e.description = f"Current: **{current_label}**"
        if footer:
            e.set_footer(text=footer)

        view = discord.ui.View(timeout=600)
        guard = _guard(user_id)

        for i, (label, value) in enumerate(choices):
            is_active = value == prefs[field]
            style = discord.ButtonStyle.success if is_active else discord.ButtonStyle.secondary
            btn = discord.ui.Button(label=label, style=style,
                                    disabled=is_active, row=i // 4)

            def make_cb(v=value):
                async def cb(interaction: discord.Interaction):
                    if not await guard(interaction):
                        return
                    new_prefs = await update_prefs(user_id, {field: v})
                    embed, sub_view = factory(user_id, new_prefs)
                    await interaction.response.edit_message(embed=embed, view=sub_view)
                return cb

            btn.callback = make_cb()
            view.add_item(btn)

        action_row = ((len(choices) - 1) // 4) + 1
        view.add_item(_preview_button(user_id, action_row))
        view.add_item(_back_button(user_id, action_row))
        return e, view
    return factory


def _label_for_field(field: str, value: str) -> str:
    if field == "gender":    return gender_label(value)
    if field == "language":  return language_label(value)
    if field == "accent":    return accent_label(value)
    if field == "character": return character_label(value)
    return str(value)


_gender_panel   = _choice_panel("Gender",   "👤", "gender",   GENDER_CHOICES)
_language_panel = _choice_panel("Language", "🌐", "language", LANGUAGE_CHOICES)
_accent_panel   = _choice_panel("Accent",   "🗣️", "accent",   ACCENT_CHOICES,
                                footer="Only affects English voices.")


# ----- Character sub-panel ------------------------------------------------

def _character_panel(user_id: int, prefs: dict):
    current = prefs.get("character", "standard")
    current_label = character_label(current)

    e = discord.Embed(color=0x5865F2)
    e.set_author(name="✨  Voice character")
    e.description = f"Current: **{current_label}**\n\n"

    for _, (label, value) in enumerate(CHARACTER_CHOICES):
        desc = character_description(value)
        marker = " ✅" if value == current else ""
        e.description += f"**{label}**{marker} — {desc}\n"

    e.set_footer(text="English only · other languages use the standard voice.")

    view = discord.ui.View(timeout=600)
    guard = _guard(user_id)

    for i, (label, value) in enumerate(CHARACTER_CHOICES):
        is_active = value == current
        style = discord.ButtonStyle.success if is_active else discord.ButtonStyle.secondary
        btn = discord.ui.Button(label=label, style=style,
                                disabled=is_active, row=i // 4)

        def make_cb(v=value):
            async def cb(interaction: discord.Interaction):
                if not await guard(interaction):
                    return
                new_prefs = await update_prefs(user_id, {"character": v})
                embed, sub_view = _character_panel(user_id, new_prefs)
                await interaction.response.edit_message(embed=embed, view=sub_view)
            return cb

        btn.callback = make_cb()
        view.add_item(btn)

    action_row = ((len(CHARACTER_CHOICES) - 1) // 4) + 1
    view.add_item(_preview_button(user_id, action_row))
    view.add_item(_back_button(user_id, action_row))
    return e, view


# ----- Rate / Pitch / Volume sub-panels ------------------------------------

def _meter_panel(title: str, emoji: str, field: str, lo: int, hi: int,
                 left_label: str, right_label: str,
                 bar_renderer, value_display, range_text: str,
                 default_step: int):
    def factory(user_id: int, prefs: dict):
        step = prefs[field]
        bar = bar_renderer(step, lo, hi, left_label, right_label)
        hint = _tuning_hint(field.replace("_step", ""), step, default_step)

        e = discord.Embed(color=0x5865F2)
        e.set_author(name=f"{emoji}  {title}")
        e.description = (
            f"## {value_display(step)}\n"
            f"```\n{bar}\n```\n"
            f"*{hint} · {range_text}*"
        )

        view = discord.ui.View(timeout=600)
        guard = _guard(user_id)

        def step_button(label: str, delta: int, row: int,
                        style=discord.ButtonStyle.secondary):
            new_val = max(lo, min(hi, step + delta))
            at_boundary = (new_val == step)
            btn = discord.ui.Button(label=label, style=style,
                                    row=row, disabled=at_boundary)

            async def cb(interaction: discord.Interaction):
                if not await guard(interaction):
                    return
                new_prefs = await update_prefs(user_id, {field: new_val})
                embed, sub_view = factory(user_id, new_prefs)
                await interaction.response.edit_message(embed=embed, view=sub_view)

            btn.callback = cb
            return btn

        view.add_item(step_button("⏪ -5", -5, 0))
        view.add_item(step_button("◀ -1",  -1, 0))
        view.add_item(step_button("▶ +1",  +1, 0))
        view.add_item(step_button("⏩ +5", +5, 0))

        reset_btn = discord.ui.Button(label="Reset", emoji="↩️",
                                       style=discord.ButtonStyle.danger, row=1,
                                       disabled=(step == default_step))

        async def on_reset(interaction: discord.Interaction):
            if not await guard(interaction):
                return
            new_prefs = await update_prefs(user_id, {field: default_step})
            embed, sub_view = factory(user_id, new_prefs)
            await interaction.response.edit_message(embed=embed, view=sub_view)

        reset_btn.callback = on_reset
        view.add_item(reset_btn)

        view.add_item(_preview_button(user_id, 1))
        view.add_item(_back_button(user_id, 1))

        return e, view
    return factory


_rate_panel = _meter_panel(
    "Speaking rate", "⚡", "rate_step", RATE_MIN, RATE_MAX,
    "Slow", "Fast", render_marker_bar, rate_display,
    "range: -50% to +50%",
    default_step=0,
)
_pitch_panel = _meter_panel(
    "Pitch", "🎵", "pitch_step", PITCH_MIN, PITCH_MAX,
    "Deep", "High", render_marker_bar, pitch_display,
    "range: -100 Hz to +100 Hz",
    default_step=0,
)
_volume_panel = _meter_panel(
    "Volume", "🔊", "volume_step", VOL_MIN, VOL_MAX,
    "Quiet", "Loud", render_fill_bar, volume_display,
    "range: 0% to 200%",
    default_step=10,
)


@bot.slash_command(description="Open your voice settings panel (private to you).")
async def settings(ctx: discord.ApplicationContext):
    await ctx.defer(ephemeral=True)
    try:
        prefs = await get_prefs(ctx.author.id)
    except Exception as e:
        print(f"[settings] load failed for {ctx.author.id}: {e}")
        await ctx.followup.send(
            "Couldn't load your settings (database error). Try again in a moment.",
            ephemeral=True,
        )
        return
    await ctx.followup.send(
        embed=_main_embed(prefs), view=_main_view(ctx.author.id, prefs),
        ephemeral=True,
    )


if not TOKEN:
    raise SystemExit("DISCORD_TOKEN missing. Copy .env.example to .env and fill it in.")

bot.run(TOKEN)
