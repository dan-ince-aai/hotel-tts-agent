"""Turn a call's voice cell into the TTS that speaks it.

Every system is spoken through its provider's official LiveKit plugin, with the plugin's own
streaming behaviour: that is the point of dogfooding. What is held constant is everything
around the TTS (the STT, the LLM, the script, turn detection), not how each plugin streams.

`tts_spec` is pure, so which plugin and settings a cell gets is tested without the plugins
installed; `make_tts` imports the plugin and builds it.
"""

from __future__ import annotations

import os
from typing import Any

from study_api import CallConfig

# Every competitor speaks the script's language. AssemblyAI library and cloned voices speak
# their recording's language and take no override, so ours is left to the voice.
SCRIPT_LANGUAGE = "en"

# Where each provider's key comes from. ElevenLabs' plugin reads ELEVEN_API_KEY on its own;
# the study's env names it ELEVENLABS_API_KEY like every other provider, so it is passed in.
API_KEY_ENV = {
    "assemblyai": "ASSEMBLYAI_API_KEY",
    "cartesia": "CARTESIA_API_KEY",
    "elevenlabs": "ELEVENLABS_API_KEY",
    "inworld": "INWORLD_API_KEY",
}


def tts_spec(cell: CallConfig) -> tuple[str, dict[str, Any]]:
    """The plugin name and constructor arguments for a cell (no API key)."""
    if cell.provider == "assemblyai":
        args: dict[str, Any] = {"model": cell.model}
        if cell.voice_id:
            args["voice"] = cell.voice_id
        return "assemblyai", args
    if cell.provider == "cartesia":
        args = {"model": cell.model, "language": SCRIPT_LANGUAGE}
        if cell.voice_id:
            args["voice"] = cell.voice_id
        return "cartesia", args
    if cell.provider == "elevenlabs":
        args = {"model": cell.model}
        if cell.voice_id:
            args["voice_id"] = cell.voice_id
        return "elevenlabs", args
    if cell.provider == "inworld":
        args = {"model": cell.model}
        if cell.voice_id:
            args["voice"] = cell.voice_id
        return "inworld", args
    raise ValueError(f"no TTS for provider {cell.provider!r}")


def make_tts(cell: CallConfig) -> Any:
    """Build the cell's TTS plugin. Raises if its provider's key is missing."""
    name, args = tts_spec(cell)
    key_env = API_KEY_ENV[cell.provider]
    api_key = os.getenv(key_env)
    if not api_key:
        raise ValueError(f"{key_env} is not set; call {cell.token} needs {cell.provider}")
    args["api_key"] = api_key

    if name == "assemblyai":
        from livekit.plugins import assemblyai

        return assemblyai.TTS(**args)
    if name == "cartesia":
        from livekit.plugins import cartesia

        return cartesia.TTS(**args)
    if name == "elevenlabs":
        from livekit.plugins import elevenlabs

        return elevenlabs.TTS(**args)
    from livekit.plugins import inworld

    return inworld.TTS(**args)
