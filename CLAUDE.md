# Agent instructions

The hotel-desk TTS blind test: a web app (TypeScript, plain Node + Vite + React) and a voice
agent (Python, LiveKit Agents, built from AssemblyAI's LiveKit reference agent). Start with
`README.md`; the agent has its own `agent/README.md`.

## Layout

- `server.ts`: the web app server (page, study API, admin, the agent's private API).
- `client.tsx`, `call.ts`, `admin.tsx`, `styles.css`: the page, built by `npm run build`.
- `study/`: schedule, persona cards, store, API, export, read-back check, admin summary.
  Every file has a spec beside it.
- `voices.ts`, `study/voice-ids.json`: the voice grid.
- `agent/`: the LiveKit desk agent.
- `scripts/clone_voices.py`: clones the voices into the competitors.
- `analysis/`: the Elo analysis (Python).

## Commands

```sh
npm test              # web app specs (vitest)
npm run typecheck
npm run build         # the page, into dist/client
npm start             # the server, on http://127.0.0.1:3000

cd agent && uv run pytest
python3 -m pytest analysis -q
```

## Rules that keep the study blind and fair

- Nothing the browser receives may name the system, provider, voice or call order. That
  includes the LiveKit token, which the browser can decode: it carries only the opaque call
  token. `study/api.test.ts` and `study/agent-api.test.ts` check this.
- Everything except the TTS is the same on every call: STT, LLM and its settings, the script,
  turn detection, interruptions, and the chat history (`use_tts_aligned_transcript` stays
  off, because not every TTS plugin sends word timings).
- Node runs `server.ts` by stripping types, so TypeScript must stay erasable
  (`erasableSyntaxOnly` is on: no parameter properties, enums or namespaces).
