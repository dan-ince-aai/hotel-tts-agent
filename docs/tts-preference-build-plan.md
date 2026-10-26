> **Superseded.** This is the original single-call plan the blind test grew
> out of: one call, one stock voice per provider, four Likert statements. The
> study now runs as a paired, same-voice comparison; see `README.md` for how it
> works today. Kept for the history of the design.

# Build plan: the hotel voice-preference study

This is the step-by-step build plan for the study described in
`tts-preference-plan.md`. That document says *what* we are making and *why*.
This one says *how*, in order. Each piece of work has a checkbox to tick as it
lands, and the assignment next to it: 🤖 (the bot, in a coding session) or
**[You]** (you, Tom).

## What changed from the two notes you added

Two clarifications in the concept plan feed into everything below:

1. **Twelve voices, not four.** Four voices each from three providers:
   AssemblyAI, Cartesia, and ElevenLabs. That means twelve copies of the hotel
   agent, one per voice, inside the one server.
2. **No separate transcription delay.** We record four speed numbers per reply
   (whole turn, end-of-speech pause, model's first word, voice's first sound)
   and drop the fifth the old plan flagged as a maybe.

## The one piece of real new building: ElevenLabs

Worth knowing before you read the phases, because it is the only surprise.

The toolkit comes with ready-made voice support for exactly three providers:
**AssemblyAI, Cartesia, and Rime.** ElevenLabs is supported only for turning
speech *into* text, not for speaking. So two of your three providers
(AssemblyAI, Cartesia) are nothing more than rows in a list — but **ElevenLabs
is a part we build ourselves.**

The good news: the toolkit has a proper, supported door for adding a voice
provider it does not ship (a function named `registerTtsKind`). So this is a
real feature, not a workaround. It is still a chunk of work — a small connector
that talks to ElevenLabs' streaming voice service and hands the sound back to
the agent — so it gets its own phase below (Phase 3).

You confirmed you need ElevenLabs, so the plan keeps it. If that ever changes,
Rime drops in with no building at all, and Phase 3 simply goes away.

## Agree these three names before the parallel work starts

A few phases below run at the same time in separate sessions. They meet at two
small seams, so we fix the names up front and nobody guesses:

- **A voice row** looks like `{ label, provider, voice }` — e.g.
  `{ label: "v04", provider: "cartesia", voice: "<id>" }`. The list lives in
  `voices.ts`.
- **The survey's save address** is a POST to `/survey` carrying
  `{ callId, name, q1, q2, q3, q4 }`. The page sends to it; the server fills in
  the hidden voice label and saves the row.
- **The hidden label** is the plain `label` from the row (`v01`…`v12`). It never
  reaches the page.

---

## Phase 1 — Decisions and accounts (do this first; it clears the way)

- [x] **[You]** Get three keys and put them in `.env` locally, then keep them for
  Render later: `ASSEMBLYAI_API_KEY`, `CARTESIA_API_KEY`, `ELEVENLABS_API_KEY`.
- [x] ~~🤖 Give you a shortlist of candidate voices for each provider — the
  AssemblyAI ones from the toolkit's own catalog, the Cartesia and ElevenLabs
  ones read fresh from each provider's current voice list (a wrong voice id
  makes an agent that connects, says it is ready, and then stays silent, so we
  never guess an id).~~ **Superseded** — you supplied the twelve picks inline
  (below), so no shortlist was produced; these ids are what `voices.ts` carries.

This isn't necessary. Here's the list of voices I want to use. 
Assembly: Jane, Alba, George, Mary
Cartesia: Blake (a167e0f3-df7e-4d52-a9c3-f949145efdab), Daniela (5c5ad5e7-1020-476b-8b91-fdcbe9cc313c), Jacqueline (9626c31c-bec5-4cca-baa8-f8ba9e84c8bc), Robyn (f31cc6a7-c1e8-4764-980c-60a361443dd1)
Elevenlabs: Jessica (cgSgspJ2msm6clMCkdW9), Eryn (DXFkLCBUTmvXpp2QwZjA), Andre Rene (GogJbMCDT0Viv4cU3N4s), Josh (ZoiZ8fuDWInAcwPXaVeq)

## Phase 2 — The voices list and the two ready providers

- [x] 🤖 Create `voices.ts`: the one list of twelve rows, and the only file
  you touch to add, remove, or swap a voice.
- [x] 🤖 Write the small helper that turns a row into a voice setting, for
  the two ready providers (AssemblyAI and Cartesia). (`ttsForRow`; the four
  ElevenLabs rows throw a signposted error until Phase 3.)
- [x] 🤖 Prove the eight ready engines (four AssemblyAI + four Cartesia)
  build locally and a call reaches one, using `npm run dev`. (`npm run build`
  is green with all eight resolving; `VOICE_LABEL=v05 npm run dev` booted the
  Cartesia engine — "Session mode resolved … tts kind cartesia" — and `/health`
  answered ok. `VOICE_LABEL` picks the dev voice, default `v01`.)

## Phase 3 — ElevenLabs voice support (the part we build)

- [x] 🤖 Write the ElevenLabs voice connector in its own file: it opens a
  streaming connection to ElevenLabs when a call starts, sends it the agent's
  words, and hands back the sound. Register it so an ElevenLabs row behaves like
  any other row. *(Done: `elevenlabs-tts.ts` is the pure descriptor the agent
  bundle imports; `elevenlabs-tts-host.ts` is the host opener — ElevenLabs'
  multi-context streaming WebSocket, one context per turn like the toolkit's own
  Cartesia opener — registered with `registerTtsKind`. The split keeps the
  WebSocket out of the guest bundle, exactly as the shipped providers are split.)*
- [x] 🤖 Extend the row-to-voice helper from Phase 2 so the four ElevenLabs
  rows build too. *(Done: `ttsForRow`'s `elevenlabs` case now returns
  `elevenLabsTts({ voice })`; `voices.test.ts` and a new `elevenlabs-tts.test.ts`
  pin the shape, all offline.)*
- [x] 🤖 Prove the four ElevenLabs engines answer a call locally, speaking
  with the real ElevenLabs service (needs the key from Phase 1). *(Done: all
  four PROVEN by `node elevenlabs-smoke.ts` on 2026-10-07 — v09 Jessica ~3.03s,
  v10 Eryn ~3.10s, v11 Andre Rene ~3.10s, v12 Josh ~3.33s of real audio; "4/4
  ElevenLabs voices answered with audio." The earlier block cleared once **[You]**
  added v10/v11/v12 to the ElevenLabs dashboard library — they previously returned
  `voice_id_does_not_exist`. A bad voice id still surfaces as a loud
  `tts_stream_error` rather than the silent agent the plan feared.)*

## Phase 4 — The routing server

- [x] 🤖 Write the small server: build the hotel agent once, make one engine
  per row, and send each incoming call to one engine by even rotation, so the
  twelve voices stay balanced.
  (`server.ts`: loads the built worker once via `loadBuiltAgent`, stands up one
  `createRuntime` engine per voice row, and serves all of them behind one
  rotating `SessionRuntime` facade with `createRuntimeServer`. A resume returns
  to the engine that first answered the call, so a reconnect keeps its voice and
  its state. The four ElevenLabs rows are skipped with a note until Phase 3
  registers the connector — same code stands up all twelve once it does.
  **The rotation is STRIPED across providers** (`interleaveByProvider`), not run
  in label order: in label order the list is grouped four-AssemblyAI then
  four-Cartesia then four-ElevenLabs, so a burst of callers would all cluster on
  one provider. Zipping the per-provider groups makes consecutive calls change
  provider — AssemblyAI → Cartesia → ElevenLabs → … — so any individual caller is
  very likely to hear a different provider each call, while every voice still
  appears once per cycle so the per-voice balance is unchanged.)
- [x] 🤖 Have the server remember which voice each call got, and serve the
  page the repo already has (start screen, call view, controls, sidebar).
  (Voice is recorded per session id — the call id the survey will carry — in a
  `callVoice` map read by the exported `voiceForCall(callId)`, ready for Phase 6/7.
  The built client is served from `.aai/client`, the default UI otherwise.
  `npm start` now runs this server; `prestart` still builds the worker.)
- [x] 🤖 Prove it: start the server, make a call, confirm a voice answers and
  the chosen voice is recorded for that call. (Booted with 8/12 engines ready;
  `/health` and `/client-config` answer ok. A WebSocket call drew 188 KB of
  agent audio — a voice answered — and four calls in a row recorded
  `v01 jane → v02 alba → v03 george → v04 mary`, the even rotation.)

## Phase 5 — The fixed booking conversation

- [x] 🤖 Replace the open-ended receptionist flow with the fixed eight-step
  booking script from the concept plan, so every caller hears the same words in
  the same order (name spelled back, a night read back, an address read back,
  the "you're a regular, it's on us" turn, goodbye).
- [x] 🤖 Keep the test suite passing against the pinned script; adjust the
  tests that assumed the old free-form flow.

## Phase 6 — The results database

- [x] 🤖 Add a Postgres driver to the project and read `DATABASE_URL` from
  the environment. *(Done: `postgres@^3.4.9` is a dependency; `db.ts` opens one
  pool from `DATABASE_URL`, which the server resolves through its existing
  `resolveAgentEnv`. `.env.example` now DECLARES `DATABASE_URL=` uncommented —
  `resolveAgentEnv` only surfaces env names this file declares, so Render's
  dashboard value reaches the server only because the name is listed. Left blank
  the server still boots and saves nothing, logging "results are NOT saved".)*
- [x] 🤖 Create the three tables with one setup file: `visitors` (one per
  person who entered a name and started a call, with the voice they got),
  `surveys` (one per finished survey), and `turns` (one per reply, for speed).
  *(Done: `db.ts`'s `ensureSchema` is the one setup file — three
  `create table if not exists` statements run on first connect, idempotent so a
  redeploy is a no-op. Every table carries `voice_label` so each query is a
  group-by with no join.)*
- [x] 🤖 Write the three save paths on the server: a `visitors` row at call
  start, a `surveys` row when the survey is sent, and a `turns` row per reply.
  Every row carries the voice label. *(Done: `recordVisitor` fires in the
  server's `onSinkCreated` where the voice is first known; `POST /survey`
  (a `request` hook on `createRuntimeServer`) parses `{ callId, name, q1..q4 }`,
  attaches the hidden label with `voiceForCall`, and calls `recordSurvey`; a
  `registerMetricsSink` reader saves a `turns` row from every `metrics.collected`
  frame, keyed by session id = call id. All three are fire-and-forget so a
  database hiccup never fails a live call. The survey also backfills the
  visitor's name — the Phase 7 name gate can save it earlier.)*
- [x] 🤖 For the speed rows, keep the four numbers (whole turn, end-of-speech
  pause, model's first word, voice's first sound) and leave out the
  transcription-delay number. Save a blank, never a zero, where a step did not
  happen in a given reply. *(Done: `turnTimings` maps `latencyMs`,
  `stt.endpointingMs`, `llm.ttftMs`, `tts.ttfbMs` → the four columns, each
  nullable; an absent stage is carried through as `null`, never 0, matching the
  source frame's "absent means did not happen". `db.test.ts` pins this and the
  survey contract offline; server boot + `/survey` were exercised with no DB
  (`{ok:true,saved:false}`, 400 on a bad body, 405 on GET). The live-DB write is
  proven in Phase 8's whole-visit run, which has a real database.)*

## Phase 7 — The name gate and the survey

- [x] 🤖 On the landing screen, keep the Start control switched off until a
  name is entered, and save that name with the visit. *(Done: `client.tsx` is now
  a Tier-2 custom component — a three-screen flow (name gate → call → survey). The
  gate's Start button is `disabled` until the trimmed name is non-empty (the bare
  `<form>` with a `required` field also blocks an empty Enter-key submit). The name
  is held in React state and carried on the survey POST; Phase 6's `recordSurvey`
  backfills it onto the call's `visitors` row, so no separate call-start endpoint
  was added — confirmed with the Phase 6 session.)*
- [x] 🤖 When the call ends, show the four-question survey on the same screen,
  built from the form pieces the toolkit already ships. On send, it posts to
  `/survey`; the server attaches the hidden voice label and saves the row. *(Done:
  an explicit "End call & rate the voice" button below the reused `ChatView`
  advances to the survey. This is deliberate over watching `state === "disconnected"`:
  the shipped `Controls` only Stop/Resume (pause) and New-Conversation (reset) —
  none calls `end()` — and a dialog reaching its `final` state stops the agent
  without closing the socket, so "disconnected" is ambiguous with a pause. The
  button calls `session.end()`; a FATAL error (a dropped call) also advances, so a
  caller is never stranded. The survey is `Form` + four `SelectField` Likert
  questions (1–5, each with an un-choosable empty default so `required` bites) +
  `SubmitButton`, posting `{ callId, name, q1..q4 }` (answers as numbers 1–5). The
  call id is captured via `mountClient`'s `onSessionId` and latched so it survives
  `end()` into the survey. Proven against the live Phase 6 handler: a valid body →
  `200 {ok:true,saved:false}` (no local DATABASE_URL), a missing callId → 400, a
  GET → 405. `tsc` and `npm run build` are green.)*

## Phase 8 — Bring it together and run locally

- [x] 🤖 Plug the ElevenLabs connector from Phase 3 into the server; confirm
  all twelve engines build and answer. *(Done: `server.ts` now imports
  `registerElevenLabsTts` and calls it in `main()` before `buildEngines`. The
  runtime resolves a voice agent's TTS opener EAGERLY at `createRuntime` time, so
  the kind has to be on the registry first or the four `elevenlabs` rows would be
  skipped — that one call is the whole seam Phases 3 and 4 left to join here. Boot
  now logs `12/12 voices ready` with v09–v12 resolving as `tts: { kind:
  'elevenlabs' }`, striped across providers; the four ElevenLabs voices were
  already proven to speak real audio in Phase 3's smoke run.)*
- [x] 🤖 Run one whole visit locally, start to finish: enter a name, take the
  call, fill the survey, and check the saved rows — a visitor row, a survey row,
  and speed rows, all tagged with the right voice label. *(Done as the agreed
  LIGHTER save-path proof — a literal run needs a microphone and a live model per
  turn, left to Phase 10 / the live link. `phase8-visit.ts` drives the exact three
  `record*` paths the server calls, against a real local Postgres (installed via
  Homebrew for the run, torn down after), for one call id tagged `v05`: a visitor
  row at call start, two turns rows (one full 820/540/210/130, one greeting-style
  with the absent STT/LLM/whole-turn stages stored BLANK not zero), and a survey
  row — the survey backfilling the visitor's name. Verified independently in psql:
  visitors 1, turns 2 (both v05), surveys 2. The real `POST /survey` endpoint on
  the running 12-engine server answered `{ok:true, saved:true}` and wrote its row
  (voice_label null — a call this process never served, as documented). The server
  boots `results database connected; visitors / surveys / turns ready`, so
  `ensureSchema` is proven against a live Postgres too.)*

## Phase 9 — Put it on Render (paid, always on)

- [x] 🤖 Write the Render setup: one web service, the build command and the
  start command, listening on the port Render hands it, and accepting outside
  traffic. *(Done: `render.yaml` is a Render Blueprint — apply it from New →
  Blueprint and Render creates the whole stack. It declares BOTH the `starter`
  (paid, always-on) web service and a `basic-256mb` (paid) managed Postgres, and
  auto-wires `DATABASE_URL` between them via `fromDatabase`. `buildCommand` runs
  `npm ci && npx aai build --skipTests`; `startCommand` is `node server.ts`
  (not `npm start`, which would re-build via prestart). `HOST=0.0.0.0` is set so
  Render can route outside traffic — server.ts otherwise binds local-only; `PORT`
  is left to Render to inject and server.ts reads it. `healthCheckPath: /health`.
  A sibling `.node-version` pins Node 26, inside `engines` `>=24 <27`.)*
- [ ] **[You]** Apply the Blueprint (New → Blueprint, point it at this repo). It
  creates the web service AND the managed Postgres for you — no separate DB
  step. On first apply, Render prompts for the three secrets left as
  `sync: false`: `ASSEMBLYAI_API_KEY`, `CARTESIA_API_KEY`, `ELEVENLABS_API_KEY`
  (`DATABASE_URL` is wired automatically, so you do not set it).
- [x] **[You]** Choose a paid, always-on instance so it never sleeps. We have the
  credits, and because we are measuring speed, a cold start would spoil the
  numbers. *(Baked into `render.yaml`: `starter` web + `basic-256mb` Postgres are
  both paid, always-on tiers. Change the plan lines there if you want bigger.)*
- [ ] 🤖 + **[You]** Deploy, then run one whole visit against the live link to
  confirm it holds outside your machine.

## Phase 10 — Round one inside, then round two outside

- [ ] **[You]** With colleagues: make calls, fill the survey, and check the saved
  rows look sane. Goal is to catch the rough edges — a voice that never loads, a
  question that reads oddly, a row that saves wrong.
- [ ] 🤖 Fix whatever round one turns up.
- [ ] **[You]** Share the link outside the company for round two.
- [ ] **[You]** Decide how many answers per voice before you trust a comparison. The
  database can count rows per voice at any time, so this does not hold up the
  build.

---

## What order to run these in

**Phase 1 is on its own, first.** It is mostly you (keys and the twelve picks),
with me handing you voice candidates to choose from. Nothing else can finish
without it.

**Then four sessions run at the same time, in separate 🤖 windows,**
because they touch different files and do not step on each other:

```
  Session A  (the server line, one window, in this order):
     Phase 2  the voices list + the two ready providers
        |
     Phase 4  the routing server
        |
     Phase 6  the results database
     — these three are the same server and the same files, so they
       stay together and go in order; splitting them would collide.

  Session B:  Phase 3   ElevenLabs voice support   (its own new file)

  Session C:  Phase 5   the fixed booking conversation  (the prompt + flow)

  Session D:  Phase 7   the name gate + the survey   (the page)
```

Sessions A, B, C, and D have no overlap while they run. They meet at only two
spots, and both are handled afterward in Phase 8: Session B's ElevenLabs
connector gets plugged into Session A's server, and Session D's survey posts to
the `/survey` address Session A builds (the shared names we fixed above).

**Then the rest is one line again:**

```
  Phase 8   bring the four sessions together, run one whole visit locally   🤖
     |
  Phase 9   put it on Render, paid and always on                     🤖 + you
     |
  Phase 10  round one inside, then round two outside                       you
```

### The short version

1. **Phase 1** — you and I, first, alone.
2. **Phases 2→4→6 (Session A)**, **3 (Session B)**, **5 (Session C)**, and
   **7 (Session D)** — all at once, four windows.
3. **Phase 8** — one window, once those four land.
4. **Phase 9**, then **Phase 10** — you lead, I help.
