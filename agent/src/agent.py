"""The Harborlight front desk, as a LiveKit agent, for the TTS blind test.

Built from AssemblyAI's LiveKit reference agent
(https://github.com/AssemblyAI-Solutions/assemblyai-livekit-reference-voice-agent): AssemblyAI
streaming STT, which also decides when the caller has finished their turn, and the LLM
through LLM Gateway. What differs is the voice: each call is spoken by a different TTS.

How a call reaches this agent:

1. The study app hands the participant's browser a LiveKit token for a room of its own, with
   this agent dispatched into it carrying only an opaque CALL TOKEN as metadata. The browser
   can read its LiveKit token, so nothing in it names the system or the voice.
2. Here, the call token is swapped for the call's voice cell (`study_api.py`), and the TTS
   for that cell is built (`tts_factory.py`).
3. Everything else is the same for every call (STT, LLM, script, turn detection), and what
   happens on the call is reported back to the study app (`reporting.py`).

    uv run src/agent.py dev       # connect to LiveKit Cloud for local development
    uv run src/agent.py start     # production; LiveKit Cloud runs this from the Dockerfile
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    TurnHandlingOptions,
    cli,
    utils,
)

# Every TTS plugin is imported here, at startup, even though only one speaks each call:
# LiveKit registers a plugin when it is first imported and refuses to do that off the
# main thread, so a plugin first imported inside a call would fail the call.
from livekit.plugins import assemblyai, cartesia, elevenlabs, inworld, openai, silero  # noqa: F401

from desk import GREETING, INSTRUCTIONS, LLM_MODEL, LLM_TEMPERATURE
from reporting import CallReporter
from study_api import CallNotFoundError, StudyApi
from tts_factory import make_tts

load_dotenv(Path(__file__).parents[1] / ".env.local")

logger = logging.getLogger("agent")

# The study app dispatches calls to the agent by this name.
AGENT_NAME = "harborlight-desk"

# --- Held constant for every system under test ---

STT_MODEL = "universal-3-6-pro"
# How quickly a turn ends versus how accurate the transcript is: "min_latency", "balanced"
# or "max_accuracy". The reference's default; the same for every call.
STT_MODE = os.getenv("STT_MODE", "balanced")
# How loud speech must be to count, for transcription and for interrupting the agent.
VAD_THRESHOLD = 0.2
# Words the persona cards use that the STT should spell right.
STT_KEYTERMS = ["Harborlight"]
# An "okay" or "uh-huh" must not cut a read-back short.
MIN_INTERRUPTION_WORDS = 2

LLM_GATEWAY_URL = "https://llm-gateway.assemblyai.com/v1"


class FrontDesk(Agent):
    def __init__(self) -> None:
        # Speak-only: no tools, so the script is the whole call.
        super().__init__(instructions=INSTRUCTIONS, tools=[])

    async def on_enter(self) -> None:
        # The fixed greeting is step 1 of the script, spoken without waiting on the LLM.
        self.session.say(GREETING)


def llm_gateway() -> openai.LLM:
    api_key = os.getenv("ASSEMBLYAI_API_KEY")
    if not api_key:
        raise ValueError("Set ASSEMBLYAI_API_KEY")
    return openai.LLM(
        model=LLM_MODEL, base_url=LLM_GATEWAY_URL, api_key=api_key, temperature=LLM_TEMPERATURE
    )


server = AgentServer()


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load(activation_threshold=VAD_THRESHOLD)


server.setup_fnc = prewarm


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    token = (ctx.job.metadata or "").strip()
    ctx.log_context_fields = {"room": ctx.room.name, "call": token}
    api = StudyApi.from_env(utils.http_context.http_session())

    try:
        cell = await api.call(token)
    except CallNotFoundError as error:
        # An old tab, a finished call, or a room nobody dispatched for the study.
        logger.warning("not serving this room: %s", error)
        ctx.shutdown(reason="unknown or finished call")
        return

    reporter = CallReporter(api, token, ctx.room.name)
    ctx.add_shutdown_callback(reporter.aclose)
    reporter.send({"type": "connected"})

    try:
        tts = make_tts(cell)
    except Exception as error:
        reporter.send({"type": "fatal", "code": "tts", "message": f"could not build TTS: {error}"})
        raise
    # Open the TTS connection now where the plugin supports it, so the greeting doesn't
    # wait on the handshake.
    if hasattr(tts, "prewarm"):
        tts.prewarm()
    logger.info("call %s: %s (%s, model %s)", token, cell.system, cell.provider, cell.model)

    session = AgentSession(
        stt=assemblyai.STT(
            model=STT_MODEL,
            mode=STT_MODE,
            vad_threshold=VAD_THRESHOLD,
            keyterms_prompt=STT_KEYTERMS,
        ),
        llm=llm_gateway(),
        tts=tts,
        vad=ctx.proc.userdata["vad"],
        turn_handling=TurnHandlingOptions(
            # Universal-3.6 Pro decides when the caller has finished speaking...
            turn_detection="stt",
            # ...so LiveKit shouldn't add its own delay on top
            endpointing={"min_delay": 0},
            interruption={
                "min_words": MIN_INTERRUPTION_WORDS,
                # A cough pauses the reply instead of cutting it off
                "resume_false_interruption": True,
            },
        ),
        tts_text_transforms=["filter_emoji", "filter_markdown"],
        # OFF, unlike the reference: it trims an interrupted reply in the chat history to the
        # words the caller heard, using the TTS's word timings. Not every plugin sends them,
        # so on it the LLM would see different histories for different systems.
        use_tts_aligned_transcript=False,
    )
    reporter.attach(session)

    await session.start(agent=FrontDesk(), room=ctx.room)


if __name__ == "__main__":
    cli.run_app(server)
