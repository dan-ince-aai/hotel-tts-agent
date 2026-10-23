> **Superseded.** This is the original single-call plan the blind test grew
> out of: one call, one stock voice per provider, four Likert statements. The
> study now runs as a paired, same-voice comparison; see `README.md` for how it
> works today. Kept for the history of the design.

# Plan: a hotel receptionist that collects opinions about our voices

## What we want to learn

People hang up on voice agents that sound wrong. So the thing that really
decides whether our text-to-speech (our "voice") is good is simple: do people
who talk to it come away thinking it sounded like a person?

We already measure our voice with numbers from test benches. Those numbers are
cheap and fast, but they are not the real judge. The real judge is a person on a
call. This project gets us that human judgment, at enough volume that we can line
it up against our numbers and see which numbers actually track what people feel.

Plain version of the goal:

- Let people have a real phone-style conversation with a voice agent.
- Right after, ask them a few quick questions about how it sounded.
- Do this without telling them whose voice they heard.
- Keep the answers next to a label for the voice they heard, so we can compare
  voices and, later, compare the answers against our test-bench numbers.

## The idea in one picture

```
   a person
      |
      v
  +-------------------------+        +------------------------+
  |  hotel front desk call  |  then  |   four quick questions |
  |  (a real conversation)  | -----> |   about how it sounded |
  +-------------------------+        +------------------------+
      |                                       |
      | (a hidden label travels the whole way)|
      v                                       v
  which voice they heard  ------------------> saved together
```

We use a hotel front desk because booking a room is a common, everyday reason to
call a business — the same shape of call our customers build. This repo already
has that hotel agent. We are adding the "pick a voice at random" part and the
"ask a few questions after" part around it.

## Why we run several copies of the agent

The one hard constraint comes from the agent toolkit we build on. A voice is
chosen once, when the engine behind the agent is built. It cannot change from one
call to the next within a single running engine.

So "assign a voice at random per call" is not a setting we can flip. Instead we
build the **same hotel agent several times over** inside one server — one engine
per voice — and when a call comes in, the server sends it to one of those engines
at random.

```
   one server, one web address
   +-----------------------------------------------+
   |   engine 1  ->  our voice                      |
   |   engine 2  ->  our other voice                |
   |   engine 3  ->  Cartesia voice                 |
   |   engine 4  ->  Rime voice                     |
   |   ... one per voice, built from the same agent |
   +-----------------------------------------------+
            ^ a call connects, the server picks one at random
```

Three things worth being clear about:

- **It is one server and one web address, not one per voice.** The engines are
  just objects held in a list in the one running server. Building an engine opens
  no phone lines and no connections — those open only while a real call is
  happening. So a dozen idle engines cost almost nothing; what costs something is
  how many people are talking at once, which is the same whether there is one
  voice or twelve.
- **The voices can come from different providers.** Each engine names its own
  provider and voice, so some can be ours (AssemblyAI) and others from Cartesia,
  Rime, or any provider the toolkit supports. Mixing providers in one list is
  fine. Each outside provider needs its own key and its own small software package
  added to the project — a one-time piece of setup per provider, noted below.
- **The server makes the choice, not the visitor's browser.** Nothing is passed
  in from the page; the server alone decides which voice answers, and records
  which one it was.

### Where you edit the list of voices

There is **one list**, in its own file, and it is the only place you touch to add,
remove, or swap a voice. Each row names a plain label (what we call it in our
notes), the provider, and the voice:

```
  voices.ts   <- THE ONE FILE YOU EDIT

    label     provider     voice
    -------   ----------   --------------------------------
    v01       AssemblyAI   jane
    v02       AssemblyAI   michael
    v03       AssemblyAI   paul
    v04       Cartesia     <a Cartesia voice id>
    v05       Rime         cove
    ...       ...          ...   (up to as many as you want)
```

The server reads this list and builds one engine per row. Adding a thirteenth
voice is adding a thirteenth row. Nothing else in the hotel agent changes — same
prompt, same booking flow, same tools, just a different voice per row.

Two setup notes that go with the list, done once:

- **Keys.** Each provider needs its own key, kept with the project's other
  secrets: `ASSEMBLYAI_API_KEY` for ours, `CARTESIA_API_KEY` for Cartesia,
  `RIME_API_KEY` for Rime, and so on. A row whose provider has no key will fail,
  so the keys and the list are edited together.
- **Provider packages.** To use a voice from Cartesia or Rime, that provider's
  small software package is added to the project once (ours needs nothing extra).
  Add the package the first time you add that provider to the list; after that,
  new voices from the same provider are just new rows.

One consequence worth stating plainly: this study runs on **our own small
server** (the toolkit supports running one yourself), not the one-button managed
release, because the managed path serves a single agent with a single voice. The
server is small — read the list, build the engines, send each call to one — but
it is a piece we own.

## How a single visit goes, start to finish

```
  1. Person opens the page, enters their name, and starts a call.
     The Start control is disabled until a name is entered; the name
     is saved with the visit.
          |
          v
  2. The server quietly rolls a die and answers with one voice.
     They are not told which, and nothing on the page gives it away.
          |
          v
  3. They talk to the hotel front desk. They try to book a room,
     ask about the pool, whatever they like. Normal call.
          |
          v
  4. They hang up (or the call ends on its own).
          |
          v
  5. The same screen now shows four short questions.
          |
          v
  6. They answer and press send.
          |
          v
  7. Their answers are saved, with the hidden label for the voice
     they just heard attached, plus the date and how long they talked.
```

The hidden label is the thread that ties the whole visit together. It is decided
in step 2 and rides along until step 7, where it is saved next to the answers.
The person never sees it.

## What the call itself does (the booking workflow)

Step 3 above is "a normal call." Here is exactly what that call is. The agent
walks every caller through the same short, fixed script, so each voice is judged
on the same words — the same names, numbers, dates and spellings — and nothing in
the flow tips off which voice is speaking.

The script is deliberately loaded with the things a voice tends to slip on:
spelling a name back, reading a date back, reading an address back. That is on
purpose — it gives the caller a fair chance to notice before they answer
questions 3 and 4.

```
  1. The agent says hello and asks if they're ready to book a room at the
     Harbor Light Hotel.

  2. When the caller says they're ready, the agent asks for their name — and,
     in the same turn, asks them to spell their last name.

  3. The agent repeats the name back and spells the last name back.

  4. The agent asks which night they want to book. Whatever night they give,
     the agent accepts it and repeats the night back.

  5. The agent says it needs to collect payment now, and that the first step
     is the address. It asks, explicitly, for the caller's address.

  6. The agent repeats the address back and asks the caller to confirm it.

  7. The twist: the agent says "oh, you're [name] from [city]. We know you.
     You're one of our regulars. We have your card on file. How are you doing
     today, [first name]?"

  8. The caller answers how they're doing. The agent says the night is on the
     hotel, for free, and that it looks forward to seeing them on the night
     they named back in step 4. It says goodbye and the call ends.
```

Two notes:

- **The "regular" twist in step 7 is the reason no real payment is taken.** The
  call collects a name, a date and an address, reads each one back, and then
  resolves without a card — which keeps the call believable and self-contained
  while still exercising the voice on all the hard material.
- **This script replaces the open-ended receptionist flow this repo ships with.**
  The repo's hotel agent is a large, free-form booking system (dozens of tools).
  For this study we want every caller to hear the same words in the same order,
  so the conversation is pinned to the script above rather than left open-ended.
  That is a change to the agent's prompt and flow, not something kept untouched —
  see "What we actually build" below.

## The four questions

All four are on the standard five-point "strongly disagree ... strongly agree"
scale, and all four are worded the same way: agreeing is the good answer. A
higher number is better on every one, so adding them up needs no flipping.

```
  #  Statement                                             Good answer
  -- ----------------------------------------------------- -----------
  1  The voice agent sounded natural.                      agree
  2  The voice agent spoke in the tone and speed of        agree
     a real person.
  3  The voice agent always correctly pronounced           agree
     commonly known names.
  4  The voice agent always correctly pronounced           agree
     numbers and abbreviations.
```

One thing to carry into the analysis later: questions 3 and 4 are about names and
numbers on purpose, because those are exactly the places a voice tends to slip.
The booking script above puts names (spelled back), a date (read back) and an
address (read back) in front of the voice, so people get a fair chance to notice.

## Where the answers go

The answers are typed on a web page, so they have to be sent somewhere to be
kept. We want one simple, shared place that collects every answer from every
copy of the agent, so that all the results sit in one list we can read and sort.

```
   Copy A survey --\
   Copy B survey ----\
   Copy C survey ------>---- one shared results list
   Copy D survey ----/       (one row per completed survey)
```

Each saved survey row holds:

```
  when          2026-10-06 14:22
  caller name   Dana              <- entered on the landing screen
  voice label   variant B          <- the hidden label
  Q1..Q4        4, 5, 2, 5          <- the four raw answers
  call length   2m 10s             <- how long they talked
  got to a      yes / no           <- did the call reach a confirmed
  booking?                            booking (optional, nice to have)
```

The home for this list is a **Postgres database on Render** (decided above). The
write path only ever adds rows; it never reads or changes old ones, which keeps
it safe. A small set of tables covers everything the study records:

```
  visitors   one row per person who entered a name and started a call
             (name, first seen, voice label they heard, call id)

  surveys    one row per completed survey (the table above), keyed to a
             visit, carrying the hidden voice label

  turns      one row per reply, for latency: the voice label, the call id,
             and latencyMs / endpointingMs / llm ttftMs / tts ttfbMs
             (see "Tracking per-turn latency")
```

The voice label lives on every table, so survey scores and latency can both be
grouped by voice without a join back to anything the caller saw. The server owns
the call-to-voice mapping (it chose the voice), so nothing the browser sends has
to carry — or could leak — which voice was heard.

Note on the "got to a booking?" line: the hotel agent already keeps a running
record of what each call accomplished (who was verified, what was booked). We
can read whether the call reached a confirmed booking and save it next to the
survey. That gives us a second, behavior-based signal — did the smoother voice
actually help people finish the task — at almost no extra cost. It is a
nice-to-have, not a blocker.

## Keeping it fair

Three rules make the results trustworthy:

- **Random, and even.** Each call is answered by a voice chosen at random, and we
  keep the voices roughly even so none is starved of responses. A simple rotation
  (row 1, then row 2, then row 3, back to row 1) does this without any cleverness.
- **Blind.** The person is not told which voice they heard, and nothing on screen
  or in the web address hints at it. We refer to the voices by plain labels
  (v01, v02, ...) everywhere people can see, and keep the real provider and voice
  names in our own list.
- **One voice per visit.** A person hears one voice for the whole call, then rates
  that one. We are not asking them to compare two clips side by side — we are
  asking how one real conversation felt, which is the thing we actually care
  about.

## Connecting the human answers to our test-bench numbers

This is the payoff. Once answers are coming in, we put the average human scores
for each voice next to the test-bench numbers we already have for that same
voice.

```
   voice     human score   our metric 1   our metric 2   ...
   -------   -----------   ------------   ------------
   A         4.3           ...            ...
   B         3.1           ...            ...
   C         4.0           ...            ...
```

If a test-bench number rises and falls in step with the human score across
voices, that number is worth trusting as a cheap stand-in. If it does not move
with human opinion, we have learned not to lean on it. Either way we come out
ahead, because today we are guessing at that link and after this we are not.

This step lives outside the agent itself — it is reading the shared results list
next to our existing numbers. We do not need to build anything special into the
agent for it, beyond making sure every answer is saved with a clear voice label.

## The screen — we reuse the one we already have

We do **not** build a new web UI. The screen is the one this repo already mounts:
the `@alexkroman1/aai-ui` client (`mountClient` in `client.tsx`), which ships the
whole call experience — a start screen, the live chat/voice view, the mic and
call controls, and the themed layout with the hotel's existing sidebar. That is
what the caller sees during steps 1–8 of the script, unchanged.

The survey rides on the same screen using the same toolkit, so nothing is
hand-rolled from scratch:

- The call's end is already observable. The client's `useSessionStatus` hook
  reports the call phase; when a live call returns to `disconnected`, the call is
  over, which is our cue to swap the chat view for the survey.
- The survey itself is built from the form components aai-ui already exports —
  `Form`, `Field`, `SelectField`/`NumberField`, `SubmitButton` — styled by the
  theme the client already uses. We assemble the four Likert questions from those
  pieces; we are not writing a new form kit.

So the only UI *work* is a small wrapper that shows the shipped chat view while
the call is live and the shipped form components once it ends, plus the code that
sends the answers on submit (see item 4 below). The look, the controls and the
sidebar are reused as-is.

## What we actually build, piece by piece

Against the code already in this repo:

```
  KEEP, unchanged:
    the web UI (the aai-ui client, controls and sidebar), the
    hotel's tools and data, the booking state machine's gates.
    We reuse the screen as-is and do not rebuild a UI.

  CHANGE:
    the conversation itself. The prompt/flow is pinned to the
    fixed booking script ("What the call itself does" above), so
    every caller hears the same words in the same order. This
    replaces the repo's open-ended, free-form receptionist flow.

  ADD:
    1. the one voices list (voices.ts) - the rows of label +
       provider + voice, plus the matching provider keys and
       provider packages. This is the file you edit to change
       which voices are in the study.

    2. our own small server that reads the list, builds one engine
       per row IN-PROCESS, and sends each incoming call to one at
       random - keeping the choice hidden and recording which voice
       answered. (How the server and the aai runtime relate is the
       crux of the implementation steps below: the runtime is a
       library this server runs, not a separate host it calls.)

    3. a name gate on the landing screen - the Start control stays
       disabled until a name is entered, and the name is saved with
       the visit. Built from the same aai-ui pieces as the survey.

    4. the four-question form, shown on the same screen once the call
       ends - assembled from the form components aai-ui already
       ships, not a new UI (see "The screen" above).

    5. a way for that form to add one row to the results database,
       carrying the hidden voice label, the date, the call length,
       and whether the call reached a booking.

    6. latency capture - a metrics sink registered on the server that
       writes one row per reply (whole-turn, endpointing, LLM TTFT,
       TTS TTFB) tagged with the voice label (see "Tracking per-turn
       latency").

    7. the results database itself (Postgres on Render) - the home
       for the visitor, survey, and turn rows.
```

The heavy part — a believable hotel call with names, numbers and a real booking
— already exists. The new work wraps around it.

## Implementation steps

This section answers the three things that were still fuzzy: where the server
runs, **how that server talks to the aai runtime**, and where the database fits.
Short version of the key insight, because it removes a whole class of plumbing:

> **The aai runtime is a library our server runs in-process — not a separate
> host we call over a network.** There is no "the runtime over here, my server
> over there" hop to design. Our Render web service imports the runtime, builds
> one engine per voice inside itself, and hands each incoming call to one of
> them. The call never leaves our process to reach "the agent."

### Why not the managed aai platform

The obvious path — `aai publish` to the managed platform — does not fit this
study, and it is worth saying why so nobody reaches for it. A published agent
serves **one agent definition with one voice**; the voice is fixed when the
engine is built and cannot vary per call (confirmed in the SDK: voice is one of
the knobs that cannot change within a session). Random-voice-per-call is exactly
the thing the managed path cannot do. So we self-host, which the SDK supports
first-class.

### How the server talks to the runtime (the crux)

The SDK hands us the two pieces that make the multi-voice server small:

- **`loadBuiltAgent(cwd)`** (`@alexkroman1/aai-cli/start`) returns the *built*
  agent definition — `agent.ts` with its `tools/` and `system-prompt.md` already
  lowered in, i.e. the full hotel call (pinned to our fixed booking script), as a
  value we can clone.
- **`createRuntime({ agent, env })`** (`@alexkroman1/aai-runtime`) turns one
  agent definition into one running engine, and `runtime.startSession(ws, …)`
  attaches a connected WebSocket to it.

So the server is, in essence:

```ts no-check
// Build the hotel agent once, then clone it per voice (each clone overrides
// only the TTS stage). voices.ts is the one list from "Where you edit the
// list of voices".
const base = await loadBuiltAgent(process.cwd());
const engines = VOICES.map((v) => ({
  label: v.label,
  runtime: createRuntime({ agent: { ...base, tts: ttsFor(v) }, env }),
}));

// On each incoming voice WebSocket, pick an engine by rotation, remember which
// voice this call got, and start the session on that engine.
function onCall(ws, callId) {
  const engine = engines[rotationCursor++ % engines.length];
  recordCallVoice(callId, engine.label);          // -> visitors table
  engine.runtime.startSession(ws, { logContext: { voice: engine.label } });
}
```

Two detail notes for whoever builds it:

- **Overriding the voice per clone.** The `voice:` shorthand only names an
  AssemblyAI voice; for Cartesia/Rime rows, override the `tts` stage with that
  provider's TTS. `ttsFor(v)` is where `voices.ts` rows become a TTS stage, and
  it is where each provider's package and key are used. Verify the exact spread
  against the SDK types when wiring it (`AgentDef`), since this is the one spot
  the plan is reasoning about shapes rather than copying a documented recipe.
- **Serving the page.** The same self-host stack serves our `client.tsx` build
  (the start screen, call view, controls, sidebar) and the static assets, so the
  caller gets the real UI from the same origin as the WebSocket. Starting from
  `createProjectServer` (which already wires the client and the `/websocket`
  route for one agent) and widening its session routing to pick among the engines
  is the smallest version; building a thin server around `createRuntime` directly
  is the fallback if that seam is too narrow.

### The database (Postgres on Render)

The SDK deliberately provisions **no database** (`there is no ctx.db`): anything
that must outlive a session and be queryable brings its own client. That is
exactly our case — survey answers and latency rows are a queryable ledger — so:

- Add a Postgres driver to the project (e.g. `postgres`) and read
  `DATABASE_URL` from the environment. Render's managed Postgres hands us that
  URL; locally it sits in `.env`.
- The three tables from "Where the answers go" (`visitors`, `surveys`, `turns`)
  are created once with a small migration/SQL file.
- **Writes happen in three places, all server-side:** the name gate writes a
  `visitors` row at call start (and records the chosen voice there), the survey
  submit writes a `surveys` row, and the metrics sink writes `turns` rows. The
  browser never writes directly and never sees a voice label.

### Wiring the four new behaviors

- **Name gate.** The landing screen keeps the Start control disabled until a name
  is entered; on start, the name (and the server-chosen voice) land in
  `visitors`. Because the server picks the voice, the browser sends only the name.
- **Survey submit.** When the call ends (the client already observes this via the
  session state returning to disconnected), the four-question form appears and
  POSTs its answers to the server, which attaches the hidden voice label for that
  call and writes a `surveys` row.
- **Latency.** Register one metrics sink on the server with
  `registerMetricsSink`. Each `metrics.collected` frame arrives with a
  `MetricsContext` (`{ agent, sessionId }`); map that to the call's voice label
  and insert a `turns` row with `latencyMs`, `stt.endpointingMs`, `llm.ttftMs`,
  `tts.ttfbMs`. A sink that throws is caught and dropped per frame, so telemetry
  can never take down a live call.
- **Booking reached (nice-to-have).** The agent already tracks what each call
  accomplished; read whether a confirmed booking happened and store it on the
  `surveys` row.

### Deploying to Render

- **One web service**, build command `npm run build`, start command the
  self-host entry (a thin `server.ts` that does the routing above, or
  `npm start`). Render runs it as a long-lived process, which is what the
  voice WebSocket needs.
- **Bind correctly.** The self-host server binds loopback by default; Render
  expects the app to listen on the port in `PORT` and accept external traffic, so
  set `HOST=0.0.0.0` and read `PORT`.
- **Secrets as environment variables:** `DATABASE_URL` (from the Render Postgres
  add-on), `ASSEMBLYAI_API_KEY`, and one key per outside provider in `voices.ts`
  (`CARTESIA_API_KEY`, `RIME_API_KEY`, …). Declare the ones the agent reads in
  `requiredEnv` so a missing key fails at build, not mid-call.
- **Auth is off, on purpose.** The self-host server has no request auth of its
  own and the page is public by decision, so no secret gate is needed. (If round
  2 ever needs to throttle abuse, `AAI_SESSION_SECRET` is the SDK's built-in
  session guard — noted, not used.)
- **Cold starts.** A free Render instance sleeps when idle; the first call after
  a quiet period pays a startup delay, and because latency is part of what we
  measure, prefer a paid always-on instance before round 2 so a cold start does
  not pollute the numbers.

### Suggested order of work

```
  1. voices.ts + ttsFor() — the four-row list and its TTS mapping, with keys
     and provider packages. Prove four engines build locally (npm run dev).
  2. The routing server — loadBuiltAgent + createRuntime per voice + rotation,
     serving the existing client. Confirm a call connects and a voice answers.
  3. Pin the conversation to the fixed booking script (prompt/flow change).
  4. Postgres + tables + the three write paths (visitors / surveys / turns).
  5. The name gate and the survey form on the shared screen.
  6. Deploy to Render (web service + Postgres), set env, test end to end.
  7. Round 1 internally; then open the link for round 2.
```

## Rolling it out

```
  Round 1  --  inside the company
               A handful of voices. We and our colleagues make calls
               and fill in the survey. Goal: prove the whole path works
               end to end and that the answers look sane, and get a
               first read on which voice people prefer.

  Round 2  --  outside the company
               Open it to people who are not us. More calls, steadier
               numbers, and the first honest comparison against our
               test-bench numbers. Before this round we tighten up who
               can reach it and how we invite people, so the responses
               are from real, intended visitors.
```

Starting inside is deliberate: it is the cheapest way to find the rough edges
(a voice that never loads, a question that reads oddly, a row that saves wrong)
before anyone outside sees them.

## Decisions made

These were open; they now have answers. None changes the shape above.

- **How many voices in the first round: four.** Four rows in `voices.ts`. Keeping
  the rotation even across four means each voice gets a quarter of the calls, so
  plan for enough calls that a quarter is still a usable sample.

User: actually, I want 4 voices per provider, and three providers, AAI, Cartesia, and 11L.

- **Where everything lives: Render.** We host the server on Render as a web
  service and a managed Postgres database on Render alongside it. That is a sound,
  simple choice and I would not do it differently for round 1 — Render runs a
  long-lived Node process (so it holds the WebSocket a voice call needs) and its
  managed Postgres is one connection string away. Two small caveats, both handled
  in the implementation steps: Render's free instances sleep when idle, so the
  first call after a quiet spell pays a cold start (fine internally, worth a paid
  instance before round 2), and the server binds the port Render hands it and
  must be told to accept outside traffic.
- **Access: a public page.** No sign-in, no allow-list, no gate on who can reach
  it. Round 2 opens to outsiders simply by sharing the link. (We still ask for a
  name on the landing screen — see below — but that identifies a respondent, it
  does not restrict access.)
- **One gate before the call: the caller's name.** The landing screen asks for a
  name and only enables the Start control once it is filled. The name is persisted
  in the database with that visit, so every survey row and every latency row can
  be traced back to who was on the call.

## Still open

- **How many answers per voice before we trust a comparison.** The owner is
  handling this; the build does not block on it. The database makes it answerable
  at any time (count rows per voice label), so we can start collecting and decide
  the threshold once we see the spread.


## Tracking per-turn latency

Beyond the survey, we record how fast each voice felt, turn by turn, because
latency is half of why an agent feels human and it varies by provider. The SDK
surfaces this for us: in pipeline mode it emits a `metrics.collected` event once
per reply, and the runtime also exposes a process-wide metrics sink
(`registerMetricsSink`) that hands every session's frames to code we write —
which is where we persist them. Each frame carries, in milliseconds:

```
  what we want to track            SDK field (metrics.collected)
  ------------------------------   ------------------------------------
  whole turn: caller stops  -->    latencyMs            (top-level)
    speaking to agent starts
  end of utterance (silence  -->   stt.endpointingMs
    before the turn is cut)
  LLM time to first token    -->   llm.ttftMs
  TTS time to first byte     -->   tts.ttfbMs
```

One honest gap: the caller asked for five signals, and four map exactly. The
fifth — a **transcription delay** measured separately from end-of-utterance — is
not its own field. The SDK times end-of-utterance (`stt.endpointingMs`) and the
whole turn (`latencyMs`), but not STT's own compute time as a distinct number.
We can still infer a residual (whole turn minus the LLM and TTS legs minus
endpointing), or raise it with the SDK; flagged so it is a known limit, not a
surprise. Every stage is optional in a frame — a greeting has no STT leg, an
interrupted reply may have no TTS leg — so rows store nulls where a stage did not
happen, never zeros.

User: I don't need transcription delay. 

## What this is not

To keep the first version small and honest:

- It is not a side-by-side clip rating tool. People have one real conversation
  and rate that.
- It does not change anything about how the hotel agent books rooms or answers
  questions. The call is the call; we are only choosing its voice and asking
  about it after.
- It does not try to judge the voice automatically. The whole point is to hear
  from people, and only then see how our own numbers line up with what they said.
