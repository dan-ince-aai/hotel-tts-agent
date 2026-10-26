# Hotel desk blind test

An internal blind listening test of text-to-speech inside a real voice-agent call. A
participant phones the Harborlight Hotel front desk twice: once with our TTS model and once
with a competitor's (Cartesia, ElevenLabs or Inworld). Both calls use the same voice, made
from one recording. They don't know which call is which, and afterwards they say which call
they would rather have had. The main outcome is an Elo rating per vendor with ours anchored
at 1000.

The voice side dogfoods AssemblyAI's
[LiveKit reference agent](https://github.com/AssemblyAI-Solutions/assemblyai-livekit-reference-voice-agent).

## How it fits together

```
 browser ──(LiveKit token for a fresh room)── web app (Render)
    │                                            ▲   │
    │ audio                     voice cell,      │   │ dispatch: "harborlight-desk",
    ▼                           events           │   │ metadata = opaque call token
 LiveKit Cloud ─────────────── desk agent (LiveKit Cloud) ──── AssemblyAI STT + LLM Gateway
                                                 └── TTS: AssemblyAI | Cartesia | ElevenLabs | Inworld
```

| Piece | Where | What it does |
| --- | --- | --- |
| The desk agent | `agent/` (Python) | One LiveKit agent for every call, with Universal-3.6 Pro STT and turn detection, `gemma-4-31b` on LLM Gateway (temperature 0.2, no tools) and the fixed booking script. The TTS is chosen per call through each provider's official LiveKit plugin. See `agent/README.md`. |
| The web app | `server.ts`, `client.tsx`, `call.ts` | Email sign-in and two calls per session. Each call joins its own LiveKit room. Then the questionnaire. |
| The voices | `study/voice-ids.json`, `voices.ts` | Nine voices. `ours` is the AssemblyAI library voice; the competitor columns are clones of the same recording. |
| The schedule | `study/design.ts`, `study/cards.ts` | Each participant's six sessions: competitor order, ours-first, a different voice each time, twelve persona cards. Admin-adjustable competitor weights. |
| The agent's API | `study/agent-api.ts` | `/internal/calls/{token}`: the agent looks up a call's voice and reports what happened, behind `STUDY_AGENT_SECRET`. |
| The records | `study/store.ts` | Postgres, or in memory for development. |
| The data | `study/export.ts`, `study/readback.ts`, `/admin` | Session and call CSVs, the read-back check, and the admin page. |
| The analysis | `analysis/` | Bradley-Terry-Davidson Elo with participant bootstrap and sensitivity fits. |

The browser never learns which system, voice or order a call used. Its LiveKit token
dispatches the agent with only an opaque call token, and the agent asks the web app for the
rest.

## The voices

Nine AssemblyAI library voices, each built from an open-dataset recording (Voice Pool v2:
GLOBE, LibriVox and Common Voice). The table is `study/voice-ids.json`.

- **English:** Audrey, Ewald, Steven (Australian), Kyla, Carrie (British), Ernest.
- **Other languages:** Magdalena (German), Malvina and Antonio Luis (Spanish). They read the English script.

Ours speaks each one natively. The competitors speak **clones of the same source recording**,
made by `scripts/clone_voices.py` (see `scripts/README.md`):

```sh
uv run scripts/clone_voices.py --clips <folder of aai-*.wav> --dry-run   # what it would do
uv run scripts/clone_voices.py --clips <folder>                            # clone, fill voice-ids.json
uv run scripts/clone_voices.py --clips <folder> --verify                   # one test line per clone
```

The clone keys must belong to the same accounts as the agent's keys, because a clone only
exists in the account that made it.

The source recordings are listed in the TTS voice catalog: `admin_requests/us/library_voice_batches/`
and `tools/library_voices/` in the DeepLearning repo, originals under
`gs://aai-legacy-central1/tts-evaluation/voice_pool_v2/v1/wavs/raw/`.

## Running it locally

Needs Node 26 (`.node-version`) for the web app, and [uv](https://docs.astral.sh/uv/) plus
the [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) for the agent.

```sh
npm install
cp .env.example .env          # LIVEKIT_*, STUDY_AGENT_SECRET, …
npm test                      # web app tests, no network
npm run build && npm start    # http://127.0.0.1:3000 and /admin

cd agent && uv sync
cp .env.example .env.local    # the same STUDY_AGENT_SECRET, STUDY_API_URL=http://127.0.0.1:3000
uv run pytest                 # agent logic tests
uv run src/agent.py dev       # registers with your LiveKit Cloud project
```

The web app refuses to start until every voice cell has an id. Before the clones exist, set
`STUDY_ALLOW_MISSING_VOICES=1` to use stock competitor voices. Those sessions are marked
rehearsal and kept out of the data. Without `DATABASE_URL`, everything is kept in memory.

## Deploying

1. **LiveKit Cloud.** Create a project. Its URL, API key and secret go on the web app.
2. **The web app on Render.** New → Blueprint → this repo (`render.yaml`). It creates the
   service and Postgres, asks for the `LIVEKIT_*` values and `STUDY_ADMIN_PASSWORD`, and
   generates `STUDY_AGENT_SECRET`.
3. **The agent on LiveKit Cloud.** From `agent/`, run `lk cloud auth`, then `lk agent create`,
   which builds `agent/Dockerfile`. Set its secrets:
   - `ASSEMBLYAI_API_KEY`, `CARTESIA_API_KEY`, `ELEVENLABS_API_KEY` and `INWORLD_API_KEY`
   - `STUDY_API_URL`: the Render URL
   - `STUDY_AGENT_SECRET`: copied from Render
4. **Check.** Open the Render URL, sign in as `you+test@assemblyai.com`, and make a call on
   each competitor. On `/admin`, tick "Include rehearsal & test" and confirm every system
   spoke.

Keep the regions fixed for the whole study. Latency is counted, not removed. Leave
`STUDY_SEED` alone once real sessions exist.

## Before launch

1. **Clone the voices** (above) and listen to every `--verify` file.
2. **Rehearse.** `STUDY_OURS_STANDIN=cartesia` speaks the "ours" column with Cartesia's
   clones. Rehearsal sessions and `+test` / `@example.com` sign-ins never count.
3. **Pilot** with a handful of real people. Check `/admin` for setup failures, read-back
   misses and slow LLM turns, by system.

## Watching the study and getting the data out

Set `STUDY_ADMIN_PASSWORD` on the server (in Render, under the service's
**Environment** tab), then open `https://<service>.onrender.com/admin` and sign
in with it. The page shows:

- **Progress:** participants, sessions, answered, scored, and setup failures by reason.
- **Head to head per competitor:** ours / tie / them counts, mean preference, and the share of sessions with ours first.
- **Mean ratings per system.**
- **Call health per system:** spoke rate, drops, fatal TTS errors, read-backs right, and median LLM and TTS latency.
- **Recent sessions:** expand one for each call's failure, ratings, read-back check and transcript.

### Matching weights

Ours is in every session; the **Matching** panel on `/admin` sets how often
each competitor is the one it faces.

- **Equal weights (the default):** the protocol's balanced six-session block.
- **Unequal weights:** new sessions are steered to the target shares, counted from the moment you save. Use this to spend sessions on the comparison that's hardest to call.
- **A weight of 0:** takes a competitor out of rotation, for example while its provider is down.

Call order stays counterbalanced per competitor either way. Each session
records which mode handed it out (`allocation` in `sessions.csv`).

Changing the weights mid-study is fine for the analysis, because each session
is an independent comparison. The cost is that a person no longer
necessarily meets every competitor.

Rehearsal sessions (stock voices or a stand-in) and `+test` / `@example.com`
sign-ins are hidden by default. Tick **Include rehearsal & test** to see them.

The **Sessions CSV** and **Calls CSV** buttons download the exports.
`sessions.csv` is one row per session in the analysis's columns; `calls.csv`
is one row per call with transcripts. To get the Elo ratings with intervals,
run the analysis on the sessions file:

```sh
python3 analysis/analyze.py sessions.csv --json results.json
```

For scripts, the same exports are at `/api/export/sessions.csv` and
`/api/export/calls.csv`. Send `Authorization: Bearer <password>`; the
generated `STUDY_ADMIN_TOKEN` also works there. Add `?all=1` to include
rehearsal and test rows.

## Known limits (accepted)

- **The LLM sometimes stalls.** In rehearsal, about 6% of turns took more than 2.4 s to start. Affected sessions are flagged `ck_slow_llm` and get their own sensitivity fit.
- **Speech recognition can mishear a detail** that the agent then reads back faithfully. The read-back check flags those calls.
- **No sign-in check and no rate limit:** anyone with the link can start sessions.
- **ElevenLabs may hit its account socket limit at peak load.** That shows up as a setup failure.
- **Inworld closes a socket after 10 idle minutes.** Calls are a few minutes long, so this shouldn't come up.
