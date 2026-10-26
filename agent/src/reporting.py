"""What the agent tells the study app about a call, as it happens.

The study app scores a session only if both calls really worked, so it needs to hear that
the agent CONNECTED, that the voice SPOKE, whether a FATAL error ended the call (and if it
was the TTS's), what each side said (for the read-back check), and each reply's timings.

The mapping from LiveKit's session events to the study's events is pure (`*_event`
functions below), so it is tested without LiveKit; `CallReporter` wires it to a session.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger("agent.reporting")


def ms(seconds: float | None) -> int | None:
    return None if seconds is None else round(seconds * 1000)


def utterance_event(role: str, text: str | None) -> dict[str, Any] | None:
    """A committed line of the transcript, or None for an empty or non-speech item."""
    if role not in ("user", "assistant") or not text or not text.strip():
        return None
    return {"type": "utterance", "role": "caller" if role == "user" else "agent", "text": text}


def turn_event(
    reply_metrics: dict[str, float],
    interrupted: bool,
    caller_metrics: dict[str, float] | None,
) -> dict[str, Any]:
    """One reply's four speed numbers, from LiveKit's per-message metrics.

    A stage that did not happen is None, never zero: the greeting has no caller turn before
    it, so it has no end-of-speech pause and no whole-turn time.
    """
    caller = caller_metrics or {}
    stopped = caller.get("stopped_speaking_at")
    started = reply_metrics.get("started_speaking_at")
    whole = started - stopped if started is not None and stopped is not None else None
    return {
        "type": "turn",
        "wholeTurnMs": ms(whole) if whole is not None and whole >= 0 else None,
        "endOfSpeechMs": ms(caller.get("end_of_turn_delay")),
        "modelFirstWordMs": ms(reply_metrics.get("llm_node_ttft")),
        "voiceFirstSoundMs": ms(reply_metrics.get("tts_node_ttfb")),
        "interrupted": bool(interrupted),
    }


def error_source(source: Any) -> str:
    """Which stage an error came from: tts, stt, llm, or internal."""
    try:
        from livekit.agents import llm, stt, tts

        if isinstance(source, tts.TTS):
            return "tts"
        if isinstance(source, stt.STT):
            return "stt"
        if isinstance(source, llm.LLM):
            return "llm"
    except ImportError:
        pass
    return "internal"


class CallReporter:
    """Batches events and posts them to the study app in the background."""

    def __init__(self, api: Any, token: str, room: str) -> None:
        self._api = api
        self._token = token
        self._room = room
        self._pending: list[dict[str, Any]] = []
        self._wake = asyncio.Event()
        self._closed = False
        self._spoke = False
        self._last_caller_metrics: dict[str, float] | None = None
        self._task = asyncio.create_task(self._run())

    def send(self, event: dict[str, Any]) -> None:
        if self._closed:
            return
        self._pending.append(event)
        self._wake.set()

    def attach(self, session: Any) -> None:
        """Listen to an AgentSession's events."""

        @session.on("agent_state_changed")
        def _on_state(ev: Any) -> None:
            if ev.new_state == "speaking" and not self._spoke:
                self._spoke = True
                self.send({"type": "spoke"})

        @session.on("conversation_item_added")
        def _on_item(ev: Any) -> None:
            item = ev.item
            role = getattr(item, "role", None)
            if role is None:
                return
            line = utterance_event(role, getattr(item, "text_content", None))
            if line is not None:
                self.send(line)
            metrics = dict(getattr(item, "metrics", None) or {})
            if role == "user":
                self._last_caller_metrics = metrics
            elif role == "assistant":
                self.send(
                    turn_event(
                        metrics, getattr(item, "interrupted", False), self._last_caller_metrics
                    )
                )
                self._last_caller_metrics = None

        @session.on("error")
        def _on_error(ev: Any) -> None:
            error = ev.error
            if getattr(error, "recoverable", True):
                return
            self.send(
                {"type": "fatal", "code": error_source(ev.source), "message": str(error)[:500]}
            )

    async def aclose(self) -> None:
        """Flush what is pending and stop."""
        self._closed = True
        self._wake.set()
        await self._task

    async def _run(self) -> None:
        while True:
            await self._wake.wait()
            self._wake.clear()
            batch, self._pending = self._pending, []
            if batch:
                await self._api.report(self._token, self._room, batch)
            if self._closed and not self._pending:
                return
