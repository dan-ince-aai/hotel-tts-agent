"""The agent's pure logic, without LiveKit or the network: the script, which TTS a call's
voice cell gets, and how session events become the study's records.

    uv run pytest
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from desk import GREETING, INSTRUCTIONS, LLM_TEMPERATURE, SCRIPT_STEPS
from reporting import CallReporter, turn_event, utterance_event
from study_api import CallConfig, parse_call
from tts_factory import tts_spec


def cell(provider: str, voice: str | None = "v-1", model: str = "m-1") -> CallConfig:
    return parse_call(
        "tok", {"system": "x", "provider": provider, "voiceId": voice, "model": model}
    )


# --- The script ---


def test_script_is_seven_steps_run_as_one_next_step_instruction() -> None:
    assert len(SCRIPT_STEPS) == 7
    for step in SCRIPT_STEPS:
        assert step in INSTRUCTIONS
    assert "NEXT step not yet done" in INSTRUCTIONS
    assert "re-ask" in INSTRUCTIONS
    assert "book a room" in GREETING
    assert LLM_TEMPERATURE == 0.2


def test_script_asks_for_written_forms_not_spelled_out_numbers() -> None:
    assert "WRITTEN form" in INSTRUCTIONS
    assert "T-H-O-M-P-S-O-N" in INSTRUCTIONS


# --- The study app's answer ---


def test_parse_call_reads_a_cell() -> None:
    c = parse_call(
        "tok",
        {
            "system": "ours",
            "provider": "assemblyai",
            "voiceId": "abc",
            "model": "assemblyai-tts-1",
            "voiceLanguage": "de",
        },
    )
    assert c == CallConfig("tok", "ours", "assemblyai", "abc", "assemblyai-tts-1", "de")


def test_parse_call_treats_a_blank_voice_as_the_provider_default() -> None:
    assert cell("cartesia", voice="").voice_id is None
    assert cell("cartesia", voice=None).voice_id is None


@pytest.mark.parametrize("body", [{"provider": "rime", "model": "m"}, {"provider": "cartesia"}])
def test_parse_call_refuses_an_unknown_provider_or_missing_model(body: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        parse_call("tok", body)


# --- Which TTS a cell gets ---


def test_each_provider_gets_its_plugin_with_the_cells_voice_and_model() -> None:
    assert tts_spec(cell("assemblyai")) == ("assemblyai", {"model": "m-1", "voice": "v-1"})
    assert tts_spec(cell("cartesia")) == (
        "cartesia",
        {"model": "m-1", "voice": "v-1", "language": "en"},
    )
    # ElevenLabs' plugin names the argument voice_id
    assert tts_spec(cell("elevenlabs")) == ("elevenlabs", {"model": "m-1", "voice_id": "v-1"})
    assert tts_spec(cell("inworld")) == ("inworld", {"model": "m-1", "voice": "v-1"})


def test_a_cell_without_a_voice_leaves_the_plugin_default() -> None:
    for provider in ("assemblyai", "cartesia", "elevenlabs", "inworld"):
        _, args = tts_spec(cell(provider, voice=None))
        assert "voice" not in args and "voice_id" not in args


# --- Session events to study events ---


def test_utterances_name_the_side_and_skip_empty_lines() -> None:
    assert utterance_event("user", "Hi") == {"type": "utterance", "role": "caller", "text": "Hi"}
    assert utterance_event("assistant", "Hello")["role"] == "agent"
    assert utterance_event("assistant", "  ") is None
    assert utterance_event("system", "x") is None


def test_a_reply_after_a_caller_turn_has_all_four_numbers() -> None:
    caller = {"stopped_speaking_at": 100.0, "end_of_turn_delay": 0.42}
    reply = {"started_speaking_at": 101.25, "llm_node_ttft": 0.31, "tts_node_ttfb": 0.12}
    assert turn_event(reply, False, caller) == {
        "type": "turn",
        "wholeTurnMs": 1250,
        "endOfSpeechMs": 420,
        "modelFirstWordMs": 310,
        "voiceFirstSoundMs": 120,
        "interrupted": False,
    }


def test_the_greeting_has_blanks_not_zeroes_for_what_did_not_happen() -> None:
    event = turn_event({"started_speaking_at": 5.0, "tts_node_ttfb": 0.2}, False, None)
    assert event["wholeTurnMs"] is None
    assert event["endOfSpeechMs"] is None
    assert event["modelFirstWordMs"] is None
    assert event["voiceFirstSoundMs"] == 200


# --- The reporter ---


class FakeApi:
    def __init__(self) -> None:
        self.posted: list[dict[str, Any]] = []

    async def report(self, token: str, room: str, events: list[dict[str, Any]]) -> None:
        self.posted.extend(events)


class FakeSession:
    def __init__(self) -> None:
        self.handlers: dict[str, Any] = {}

    def on(self, name: str):
        def register(fn):
            self.handlers[name] = fn
            return fn

        return register


class Obj:
    def __init__(self, **kw: Any) -> None:
        self.__dict__.update(kw)


class TTSFailureError(Exception):
    recoverable = False


async def test_reporter_turns_session_events_into_study_events() -> None:
    api = FakeApi()
    reporter = CallReporter(api, "tok", "room-1")
    session = FakeSession()
    reporter.attach(session)
    reporter.send({"type": "connected"})

    session.handlers["agent_state_changed"](Obj(new_state="speaking"))
    session.handlers["agent_state_changed"](Obj(new_state="listening"))
    session.handlers["agent_state_changed"](Obj(new_state="speaking"))  # spoke is sent once
    session.handlers["conversation_item_added"](
        Obj(
            item=Obj(
                role="user",
                text_content="Jennifer Thompson",
                metrics={"stopped_speaking_at": 10.0, "end_of_turn_delay": 0.5},
            )
        )
    )
    session.handlers["conversation_item_added"](
        Obj(
            item=Obj(
                role="assistant",
                text_content="Thank you, Jennifer.",
                interrupted=True,
                metrics={"started_speaking_at": 11.0, "llm_node_ttft": 0.3},
            )
        )
    )
    session.handlers["error"](Obj(error=Obj(recoverable=True), source=None))  # not fatal
    session.handlers["error"](Obj(error=TTSFailureError("socket closed"), source=None))
    await reporter.aclose()

    types = [e["type"] for e in api.posted]
    assert types == ["connected", "spoke", "utterance", "utterance", "turn", "fatal"]
    turn = api.posted[4]
    assert turn["wholeTurnMs"] == 1000 and turn["endOfSpeechMs"] == 500 and turn["interrupted"]
    assert api.posted[5]["code"] == "internal" and "socket closed" in api.posted[5]["message"]


async def test_reporter_sends_nothing_after_closing() -> None:
    api = FakeApi()
    reporter = CallReporter(api, "tok", "room-1")
    await reporter.aclose()
    reporter.send({"type": "spoke"})
    await asyncio.sleep(0)
    assert api.posted == []
