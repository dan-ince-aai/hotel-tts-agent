"""The agent's side of the study app's private API.

The browser never learns which system or voice a call uses: the call is dispatched to this
agent with only an opaque call token in its metadata. The agent swaps the token for the
call's voice cell here, and reports back what happened on the call.

    GET  {STUDY_API_URL}/internal/calls/{token}          -> the call's voice cell
    POST {STUDY_API_URL}/internal/calls/{token}/events   -> what happened on the call

Both carry `Authorization: Bearer {STUDY_AGENT_SECRET}`.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Any, Literal

import aiohttp

logger = logging.getLogger("agent.study_api")

Provider = Literal["assemblyai", "cartesia", "elevenlabs", "inworld"]
PROVIDERS: tuple[Provider, ...] = ("assemblyai", "cartesia", "elevenlabs", "inworld")


class CallNotFoundError(Exception):
    """The token names no call, or one that is already over."""


@dataclass(frozen=True)
class CallConfig:
    """One call's voice cell: who speaks it, with which voice and model."""

    token: str
    system: str
    provider: Provider
    voice_id: str | None
    model: str
    # The language of the voice's recording, e.g. "en" or "de"
    voice_language: str


def parse_call(token: str, body: dict[str, Any]) -> CallConfig:
    """Validate the study app's answer, so a bad cell fails loudly before the call starts."""
    provider = body.get("provider")
    if provider not in PROVIDERS:
        raise ValueError(f"call {token}: unknown provider {provider!r}")
    model = body.get("model")
    if not isinstance(model, str) or not model:
        raise ValueError(f"call {token}: missing model")
    voice_id = body.get("voiceId")
    return CallConfig(
        token=token,
        system=str(body.get("system", "")),
        provider=provider,
        voice_id=voice_id if isinstance(voice_id, str) and voice_id else None,
        model=model,
        voice_language=str(body.get("voiceLanguage") or "en"),
    )


class StudyApi:
    def __init__(self, base_url: str, secret: str, session: aiohttp.ClientSession) -> None:
        self._base = base_url.rstrip("/")
        self._headers = {"authorization": f"Bearer {secret}"}
        self._session = session

    @classmethod
    def from_env(cls, session: aiohttp.ClientSession) -> StudyApi:
        base = os.getenv("STUDY_API_URL")
        secret = os.getenv("STUDY_AGENT_SECRET")
        if not base or not secret:
            raise ValueError("Set STUDY_API_URL and STUDY_AGENT_SECRET")
        return cls(base, secret, session)

    async def call(self, token: str) -> CallConfig:
        url = f"{self._base}/internal/calls/{token}"
        timeout = aiohttp.ClientTimeout(total=10)
        async with self._session.get(url, headers=self._headers, timeout=timeout) as res:
            if res.status in (404, 409):
                raise CallNotFoundError(f"call {token}: {res.status} {await res.text()}")
            res.raise_for_status()
            return parse_call(token, await res.json())

    async def report(self, token: str, room: str, events: list[dict[str, Any]]) -> None:
        """Send events; a failure is logged, never raised, so reporting can't break a call."""
        if not events:
            return
        url = f"{self._base}/internal/calls/{token}/events"
        timeout = aiohttp.ClientTimeout(total=10)
        for attempt in range(3):
            try:
                async with self._session.post(
                    url,
                    headers=self._headers,
                    json={"room": room, "events": events},
                    timeout=timeout,
                ) as res:
                    if res.status < 500:
                        if res.status >= 400:
                            logger.warning(
                                "study app refused events: %s %s", res.status, await res.text()
                            )
                        return
            except (aiohttp.ClientError, asyncio.TimeoutError) as error:
                logger.warning("reporting events failed (attempt %d): %s", attempt + 1, error)
            await asyncio.sleep(0.5 * (attempt + 1))
        logger.error("dropped %d event(s) for call %s", len(events), token)
