# Harborlight desk agent (LiveKit)

The voice side of the hotel-desk blind test: one LiveKit agent that answers every call, with a
different TTS per call. Built from AssemblyAI's
[LiveKit reference agent](https://github.com/AssemblyAI-Solutions/assemblyai-livekit-reference-voice-agent).

| File | What it does |
|---|---|
| `src/agent.py` | The entrypoint. It swaps the call token for the call's voice cell, builds the session and reports back. |
| `src/desk.py` | The fixed seven-step booking script, the greeting, and the LLM settings. |
| `src/tts_factory.py` | Builds the voice cell's TTS: AssemblyAI, Cartesia, ElevenLabs or Inworld, each through its official LiveKit plugin. |
| `src/study_api.py` | The study app's private API: look up a call, report what happened on it. |
| `src/reporting.py` | Maps session events to study records: connected, spoke, fatal errors, transcript lines, per-reply timings. |

## What's the same on every call

- **STT:** AssemblyAI Universal-3.6 Pro, which also decides when the caller has finished their turn (`turn_detection="stt"`, no extra LiveKit delay).
- **LLM:** `gemma-4-31b` through LLM Gateway, temperature 0.2, no tools.
- **Script and greeting:** the same for every call.
- **Interruptions:** a barge-in needs 2+ words, and a false interruption resumes the reply.
- **No filler:** nothing fills dead air, so a slow LLM turn is the same silence on every system.
- **Chat history:** the TTS-aligned transcript is **off**. Not every plugin sends word timings, so leaving it on would give the LLM a different chat history depending on the system.

Only the TTS differs, including how each plugin streams. That's what dogfooding the plugins measures.

## How a call reaches the agent

1. The study app gives the browser a LiveKit token for a fresh room, with `harborlight-desk` dispatched into it. The dispatch metadata is only an opaque call token: the browser can decode its LiveKit token, so nothing in it may name a system or a voice.
2. The agent calls `GET {STUDY_API_URL}/internal/calls/{token}` (Bearer `STUDY_AGENT_SECRET`), which returns `{ system, provider, voiceId, model, voiceLanguage }`.
3. During the call it posts events to `POST {STUDY_API_URL}/internal/calls/{token}/events`:
   - `connected`
   - `spoke`
   - `fatal { code: tts|stt|llm|internal, message }`
   - `utterance { role: agent|caller, text }`
   - `turn { wholeTurnMs, endOfSpeechMs, modelFirstWordMs, voiceFirstSoundMs, interrupted }`

## Run it

```console
uv sync
cp .env.example .env.local      # fill it in
uv run pytest                   # logic tests; the LLM script test also needs ASSEMBLYAI_API_KEY
uv run src/agent.py dev         # connect to your LiveKit Cloud project
```

To deploy to LiveKit Cloud, run `lk agent create` from this folder. It builds the `Dockerfile`. Set the variables from `.env.example` as the agent's secrets.
