"""The script, as the live LLM plays it: text in, text out, through the LLM Gateway.

These need LiveKit Agents installed and ASSEMBLYAI_API_KEY, and spend a little money, so they
skip without them. They check what a voice test depends on: an untidy caller doesn't push the
script ahead, and the read-backs come back complete and in written form.

    uv run pytest tests/test_script.py
"""

from __future__ import annotations

import os
import re
from collections.abc import AsyncIterator

import pytest

livekit_agents = pytest.importorskip("livekit.agents", minversion="1.8.9")
pytestmark = pytest.mark.skipif(
    not os.getenv("ASSEMBLYAI_API_KEY"), reason="needs ASSEMBLYAI_API_KEY for the LLM Gateway"
)

from agent import FrontDesk, llm_gateway  # noqa: E402


@pytest.fixture
async def session() -> AsyncIterator[livekit_agents.AgentSession]:
    async with llm_gateway() as agent_llm, livekit_agents.AgentSession(llm=agent_llm) as session:
        await session.start(FrontDesk())
        yield session


async def said(session: livekit_agents.AgentSession, line: str) -> str:
    result = await session.run(user_input=line)
    replies = [
        event.item.text_content or ""
        for event in result.events
        if getattr(event, "item", None) is not None
        and getattr(event.item, "role", "") == "assistant"
    ]
    return " ".join(replies)


async def test_an_untidy_caller_still_gets_complete_read_backs(
    session: livekit_agents.AgentSession,
) -> None:
    transcript = []
    for line in [
        "Hello?",
        "Yes, ready.",
        "Jennifer Thompson. T, H, O, M...",
        "...P, S, O, N.",
        "Okay.",
        "Sunday, March twenty-first.",
        "1847 Maple Ridge Drive, apartment 4B, Columbus, Ohio, 43215.",
        "Yes.",
        "Great, thanks.",
    ]:
        transcript.append(await said(session, line))
    text = "\n".join(transcript)

    # The full spelling came back, not the half given in the first breath.
    assert re.search(r"T-?H-?O-?M-?P-?S-?O-?N", text, re.IGNORECASE), text
    assert re.search(r"March 21", text, re.IGNORECASE), text
    assert "1847" in text and "43215" in text, text
    assert re.search(r"(on the house|free)", text, re.IGNORECASE), text
