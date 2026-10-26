# Hotel desk blind test

An internal blind listening test of text-to-speech inside a real voice-agent
call. A participant phones the Harborlight Hotel front desk twice: once with our
TTS model and once with a competitor's (Cartesia, ElevenLabs or Inworld). Both
calls use the same voice, cloned from one recording into each model. They don't
know which call is which, and afterwards they say which call they would rather
have had. The main outcome is an Elo rating per vendor with ours anchored at
1000.

Built on Tom's hotel voice-agent demo with the [aai](https://github.com/alexkroman/agent)
toolkit.

## How it fits together

| Piece | File | What it does |
| --- | --- | --- |
| The call | `desk.ts`, `system-prompt.md`, `agent.ts` | One fixed seven-step booking script, run as a single "do the next step not yet done" instruction. LLM `gemma-4-31b`, speak-only, temperature 0.2, dead-air filler off, barge-in needs 2+ words. |
| The voices | `voices.ts` | The 4 × 4 grid of voices (Jane, Shirley, Eli, Charles) and systems (ours, Cartesia, ElevenLabs, Inworld), each cell a clone id. |
| The schedule | `study/design.ts`, `study/cards.ts` | Each participant's six-session block: competitor order, ours-first, voice rotation, and twelve persona cards. |
| The app | `server.ts`, `study/api.ts`, `client.tsx` | Email sign-in, two calls per session routed by opaque token to a hidden engine, then the questionnaire. |
| The records | `study/store.ts` | Postgres (or in memory for development). |
| The data | `study/export.ts`, `study/readback.ts` | Session CSV for the analysis, call CSV with transcripts, and the automatic read-back check. |
| The admin page | `admin.tsx`, `study/admin.ts` | `/admin`, behind `STUDY_ADMIN_PASSWORD`: progress, tallies, call health, transcripts, CSV downloads. |
| The analysis | `analysis/` | Bradley-Terry-Davidson Elo with participant bootstrap and sensitivity fits. See `analysis/README.md`. |

The page never learns which system, voice or order a call used. It holds only
a call token, and the server picks the engine.

## Running it locally

Needs Node 26 (`.node-version`).

```sh
npm install
cp .env.example .env      # then fill in the four provider keys
npm test                  # the suite (no network, no keys needed)
```

The server refuses to start until all sixteen voice cells have clone ids. Until
they do, run with stock voices:

```sh
STUDY_ALLOW_MISSING_VOICES=1 npm start    # builds, then serves http://127.0.0.1:3000
```

Without `DATABASE_URL`, everything is kept in memory and lost on restart.
Sessions from a server running stock voices or a stand-in are marked
`rehearsal` and never appear in the default export.

`npm run dev` (`aai dev`) runs a single agent with one voice cell, picked with
`DEV_CELL=cartesia:shirley`. That's useful for working on the script, but it
isn't the study app.

## Before launch

### 1. Clone the voices

Each voice is one reference recording, cloned into every system:

- **Jane and Charles:** the original studio recordings behind the Pocket TTS presets (10–12 s each).
- **Shirley and Eli:** Voice Pool v2 readers (LibriVox `en:librivox:10252` and `en:librivox:11357`).

Clone each into the **same accounts whose keys the server runs with**, because
a clone lives in the account that made it. Ours goes into `assemblyai-tts-1`
on production us-east-1. Then paste the ids into `VOICE_IDS` in `voices.ts`
and check each clone by ear:

```sh
node elevenlabs-smoke.ts     # speaks a line through every ElevenLabs clone in the grid
node inworld-smoke.ts        # same for Inworld
```

### 2. Rehearse

With the competitor clones in but ours not yet, set `STUDY_OURS_STANDIN=cartesia`
to have Cartesia's clones speak the "ours" column. That's the protocol's
rehearsal setup. Rehearsal sessions are marked and kept out of the data.

Use a smoke-test address to sign in (anything `@example.com`, or a `+test` tag
like `you+test@assemblyai.com`). Those participants never count either.

### 3. Pilot

Run a handful of real people on the deployed server. Then check the call CSV
(below) for setup failures, read-back misses and slow LLM turns, by system.

## Deploying (Render)

`render.yaml` is a Blueprint. In Render: **New → Blueprint →** this repo. It
creates the web service and a Postgres database in Oregon, wires
`DATABASE_URL`, asks for the four provider keys, and generates
`STUDY_ADMIN_TOKEN`.

Calls are long-lived WebSockets, so this needs an always-on server. It won't
work on a serverless platform such as Vercel.

Keep the region and the plan fixed for the whole study. Latency is counted,
not removed, so moving the server mid-study changes what's being measured.

Leave `STUDY_SEED` alone once real sessions exist: changing it reshuffles
everyone's remaining sessions.

## Watching the study and getting the data out

Set `STUDY_ADMIN_PASSWORD` on the server (in Render, under the service's
**Environment** tab), then open `https://<service>.onrender.com/admin` and sign
in with it. The page shows:

- **Progress:** participants, sessions, answered, scored, and setup failures by reason.
- **Head to head per competitor:** ours / tie / them counts, mean preference, and the share of sessions with ours first.
- **Mean ratings per system.**
- **Call health per system:** spoke rate, drops, fatal TTS errors, read-backs right, and median LLM and TTS latency.
- **Recent sessions:** expand one for each call's failure, ratings, read-back check and transcript.

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
