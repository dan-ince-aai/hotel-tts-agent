/// <reference types="vite/client" />
import "./styles.css";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./admin.tsx";
import { type CallState, useLiveCall } from "./call.ts";
import type { CardView } from "./study/cards.ts";

/**
 * The blind test's one page.
 *
 * A visit: SIGN IN with an email → a SESSION of two calls to the Harborlight
 * front desk, each with its own persona card → the QUESTIONNAIRE → the next
 * session, up to six.
 *
 * ## What the page knows, and what it never does
 *
 * The server hands a session over as two opaque call tokens and two persona
 * cards (`study/api.ts`). Which call is ours, which competitor, which voice —
 * none of it reaches the browser. A call joins a LiveKit room the server set up
 * for it, with the desk agent dispatched in carrying only the call token
 * (`call.ts`). The page shows no transcript either: the participant judges only
 * what they hear.
 *
 * ## Calls end three ways
 *
 * The caller presses END CALL (the call is done); the call DROPS (the room or the
 * agent went away, or the agent never answered — they may retry it, which the
 * agent counts as another attempt, or skip it); or they SKIP it because it is not
 * working. A session with a skipped call
 * is closed without the questionnaire — there is nothing fair to compare — and
 * still counts toward the six.
 *
 * The same bundle serves the admin page (`admin.tsx`) at `/admin`; the server
 * hands both paths this page, and the path picks the screen.
 */

// ---------------------------------------------------------------------------
// The API.
// ---------------------------------------------------------------------------

interface Progress {
  participant: string;
  completed: number;
  total: number;
  canContinue: boolean;
  /** A session was handed out and not finished; Start resumes it. */
  open: boolean;
}

interface SessionView {
  session: string;
  index: number;
  total: number;
  calls: { token: string; position: 1 | 2; card: CardView; done: boolean; skipped: boolean }[];
}

interface Ratings {
  naturalness: number;
  tone: number;
  accuracy: number;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `the server answered ${response.status}`);
  return payload as T;
}

/** Fire-and-forget call events; a lost one must not strand the participant. */
function reportCall(call: string, type: "completed" | "skipped" | "dropped"): void {
  post("/api/calls/event", { call, type }).catch(() => {});
}

const PARTICIPANT_KEY = "harborlight.participant";

function rememberedParticipant(): string | null {
  try {
    return localStorage.getItem(PARTICIPANT_KEY);
  } catch {
    return null;
  }
}

function rememberParticipant(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(PARTICIPANT_KEY);
    else localStorage.setItem(PARTICIPANT_KEY, token);
  } catch {
    // Private mode or blocked storage: the participant signs in again next time.
  }
}

// ---------------------------------------------------------------------------
// Building blocks.
// ---------------------------------------------------------------------------

/** A centered card on the themed page — the frame every screen shares. */
function CenterCard({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-aai-bg p-4 text-aai-text">
      <div
        className={`flex w-full ${wide ? "max-w-2xl" : "max-w-md"} flex-col gap-6 rounded-2xl bg-aai-surface p-6 shadow-lg sm:p-8`}
      >
        {children}
      </div>
    </main>
  );
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="text-balance text-2xl font-bold">{title}</h1>
      {children && <div className="text-pretty text-sm leading-relaxed opacity-70">{children}</div>}
    </header>
  );
}

function Button({
  children,
  onClick,
  disabled = false,
  kind = "primary",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: "primary" | "quiet";
  type?: "button" | "submit";
}) {
  const look =
    kind === "primary"
      ? "bg-aai-primary text-aai-bg font-semibold"
      : "border border-aai-border text-aai-text opacity-80";
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-4 py-2.5 text-base transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${look}`}
    >
      {children}
    </button>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="text-sm text-red-400">{error}</p> : null;
}

/** The persona card: who the caller is, which night, where they live. */
function PersonaCard({ card }: { card: CardView }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl border border-aai-border bg-aai-bg p-4 text-sm">
      <dt className="opacity-60">Your name</dt>
      <dd className="font-medium">{card.name}</dd>
      <dt className="opacity-60">Night</dt>
      <dd className="font-medium">{card.night}</dd>
      <dt className="opacity-60">Address</dt>
      <dd className="font-medium">{card.address}</dd>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Sign in.
// ---------------------------------------------------------------------------

function SignIn({ onSignedIn }: { onSignedIn: (progress: Progress) => void }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <CenterCard>
      <Heading title="Hotel desk listening test">
        You'll phone a hotel front desk twice, then tell us which call you'd rather have had. Each
        session takes about five minutes; you can do up to six. Use headphones and a quiet room.
      </Heading>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          post<Progress>("/api/signin", { email })
            .then((progress) => {
              rememberParticipant(progress.participant);
              onSignedIn(progress);
            })
            .catch((cause: Error) => setError(cause.message))
            .finally(() => setBusy(false));
        }}
      >
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Work email
          <input
            autoFocus
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@assemblyai.com"
            className="rounded-lg border border-aai-border bg-aai-bg px-3 py-2 text-base text-aai-text outline-none focus:border-aai-primary"
          />
        </label>
        <ErrorLine error={error} />
        <Button type="submit" disabled={busy || email.trim() === ""}>
          Continue
        </Button>
      </form>
    </CenterCard>
  );
}

// ---------------------------------------------------------------------------
// One call.
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<CallState, string> = {
  connecting: "Connecting…",
  waiting: "Ringing the front desk…",
  listening: "Listening — go ahead",
  thinking: "…",
  speaking: "The desk is speaking",
};

/** The live call: joins on mount, hangs up on the way out. A drop goes to the parent. */
function LiveCall({
  participant,
  call,
  label,
  onEnded,
  onDropped,
  onSkipped,
}: {
  participant: string;
  call: SessionView["calls"][number];
  label: string;
  onEnded: () => void;
  onDropped: () => void;
  onSkipped: () => void;
}) {
  const live = useLiveCall(participant, call.token, (why) => {
    console.warn(`call dropped: ${why}`);
    onDropped();
  });

  return (
    <CenterCard>
      <Heading title={label}>Book a room using the details on your card.</Heading>
      <PersonaCard card={call.card} />
      <div className="flex items-center gap-3 rounded-lg bg-aai-bg px-4 py-3 text-sm">
        <span
          className={`h-2.5 w-2.5 rounded-full ${live.state === "speaking" ? "animate-pulse bg-aai-primary" : live.state === "listening" ? "bg-green-400" : "bg-aai-border"}`}
        />
        <span>{STATE_LABEL[live.state]}</span>
      </div>
      {live.audioBlocked && (
        <Button onClick={live.resumeAudio}>Tap to hear the desk</Button>
      )}
      <p className="text-xs leading-relaxed opacity-60">
        When the desk says goodbye, end the call. If you can't hear anything or the call isn't
        working, skip it.
      </p>
      <div className="flex flex-wrap justify-between gap-3">
        <Button
          kind="quiet"
          onClick={() => {
            live.end();
            onSkipped();
          }}
        >
          Skip — not working
        </Button>
        <Button
          onClick={() => {
            live.end();
            onEnded();
          }}
        >
          End call
        </Button>
      </div>
    </CenterCard>
  );
}

// ---------------------------------------------------------------------------
// The questionnaire.
// ---------------------------------------------------------------------------

const PREFERENCE: readonly { value: number; label: string }[] = [
  { value: -2, label: "Call 1, clearly" },
  { value: -1, label: "Call 1, slightly" },
  { value: 0, label: "No preference" },
  { value: 1, label: "Call 2, slightly" },
  { value: 2, label: "Call 2, clearly" },
];

const REASONS: readonly { value: string; label: string }[] = [
  { value: "human", label: "Sounded more human" },
  { value: "tone", label: "Tone fit the conversation better" },
  { value: "accuracy", label: "Said names, dates and numbers right" },
  { value: "speed", label: "Responded faster" },
  { value: "other", label: "Something else" },
];

const RATING_QUESTIONS: readonly { key: keyof Ratings; question: string; low: string; high: string }[] = [
  {
    key: "naturalness",
    question: "How much did it sound like a real person?",
    low: "Obviously a computer",
    high: "Could be a person",
  },
  { key: "tone", question: "How well did its tone fit the conversation?", low: "Very wrong", high: "Exactly right" },
  {
    key: "accuracy",
    question: "How correctly did it say names, dates, numbers and the address?",
    low: "Many mistakes",
    high: "No mistakes",
  },
];

function Scale({
  name,
  value,
  onChange,
  low,
  high,
}: {
  name: string;
  value: number | undefined;
  onChange: (value: number) => void;
  low: string;
  high: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5].map((point) => (
          <label
            key={point}
            className={`flex h-10 flex-1 cursor-pointer items-center justify-center rounded-lg border text-sm ${value === point ? "border-aai-primary bg-aai-primary text-aai-bg" : "border-aai-border"}`}
          >
            <input
              type="radio"
              name={name}
              value={point}
              checked={value === point}
              onChange={() => onChange(point)}
              className="sr-only"
            />
            {point}
          </label>
        ))}
      </div>
      <div className="flex justify-between text-xs opacity-60">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

function Questionnaire({
  participant,
  view,
  onDone,
}: {
  participant: string;
  view: SessionView;
  onDone: (progress: Progress) => void;
}) {
  const [preference, setPreference] = useState<number | undefined>(undefined);
  const [reasons, setReasons] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [ratings, setRatings] = useState<Record<1 | 2, Partial<Ratings>>>({ 1: {}, 2: {} });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const complete = (r: Partial<Ratings>): r is Ratings =>
    r.naturalness !== undefined && r.tone !== undefined && r.accuracy !== undefined;
  const ready = preference !== undefined && complete(ratings[1]) && complete(ratings[2]);

  function toggleReason(reason: string) {
    setReasons((current) =>
      current.includes(reason)
        ? current.filter((r) => r !== reason)
        : current.length < 2
          ? [...current, reason]
          : current,
    );
  }

  return (
    <CenterCard wide>
      <Heading title="Which call would you rather have had?">
        Everything you experienced counts — the voice, the speed, and whether it got your details
        right.
      </Heading>
      <form
        className="flex flex-col gap-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setBusy(true);
          setError(null);
          post<Progress>("/api/responses", {
            participant,
            session: view.session,
            preference,
            reasons,
            ...(comment.trim() ? { comment: comment.trim() } : {}),
            call1: ratings[1],
            call2: ratings[2],
          })
            .then(onDone)
            .catch((cause: Error) => setError(cause.message))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-3 font-semibold">
            Overall, which agent would you rather talk to on a call like this?
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
            {PREFERENCE.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer items-center justify-center rounded-lg border px-2 py-3 text-center text-sm ${preference === option.value ? "border-aai-primary bg-aai-primary text-aai-bg" : "border-aai-border"}`}
              >
                <input
                  type="radio"
                  name="preference"
                  checked={preference === option.value}
                  onChange={() => setPreference(option.value)}
                  className="sr-only"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-3 font-semibold">
            Why? Pick up to two <span className="font-normal opacity-60">(optional)</span>
          </legend>
          {REASONS.map((reason) => (
            <label key={reason.value} className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={reasons.includes(reason.value)}
                disabled={!reasons.includes(reason.value) && reasons.length >= 2}
                onChange={() => toggleReason(reason.value)}
              />
              {reason.label}
            </label>
          ))}
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={2000}
            rows={2}
            placeholder="Anything else? (optional)"
            className="mt-2 rounded-lg border border-aai-border bg-aai-bg px-3 py-2 text-sm text-aai-text outline-none focus:border-aai-primary"
          />
        </fieldset>

        {([1, 2] as const).map((position) => (
          <fieldset key={position} className="flex flex-col gap-5">
            <legend className="mb-3 font-semibold">Call {position}</legend>
            {RATING_QUESTIONS.map((q) => (
              <div key={q.key} className="flex flex-col gap-2">
                <span className="text-sm">{q.question}</span>
                <Scale
                  name={`call${position}-${q.key}`}
                  value={ratings[position][q.key]}
                  onChange={(value) =>
                    setRatings((current) => ({ ...current, [position]: { ...current[position], [q.key]: value } }))
                  }
                  low={q.low}
                  high={q.high}
                />
              </div>
            ))}
          </fieldset>
        ))}

        <ErrorLine error={error} />
        <Button type="submit" disabled={!ready || busy}>
          Send answers
        </Button>
      </form>
    </CenterCard>
  );
}

// ---------------------------------------------------------------------------
// The app.
// ---------------------------------------------------------------------------

type Screen =
  | { kind: "loading" }
  | { kind: "signin" }
  | { kind: "home"; progress: Progress }
  | { kind: "brief"; view: SessionView; call: number }
  | { kind: "call"; view: SessionView; call: number; attempt: number }
  | { kind: "dropped"; view: SessionView; call: number; attempt: number }
  | { kind: "questionnaire"; view: SessionView }
  | { kind: "closed"; progress: Progress };

function StudyApp() {
  const [participant, setParticipant] = useState<string | null>(rememberedParticipant);
  const [screen, setScreen] = useState<Screen>({ kind: participant ? "loading" : "signin" });
  const [error, setError] = useState<string | null>(null);
  // Which calls of the current session were skipped; any skip closes it unanswered.
  const skipped = useRef(new Set<string>());

  // A remembered participant: re-read their progress (the token alone is enough).
  // Reading progress hands out nothing; a session is only created on Start.
  useEffect(() => {
    if (screen.kind !== "loading" || participant === null) return;
    post<Progress>("/api/progress", { participant })
      .then((progress) => setScreen({ kind: "home", progress }))
      .catch(() => {
        rememberParticipant(null);
        setParticipant(null);
        setScreen({ kind: "signin" });
      });
  }, [screen.kind, participant]);

  function openSession(view: SessionView) {
    skipped.current = new Set(view.calls.filter((call) => call.skipped).map((call) => call.token));
    const next = view.calls.findIndex((call) => !call.done);
    if (next === -1) afterCall(view, view.calls.length - 1);
    else setScreen({ kind: "brief", view, call: next });
  }

  function startSession() {
    if (participant === null) return;
    setError(null);
    post<SessionView>("/api/sessions", { participant })
      .then(openSession)
      .catch((cause: Error) => setError(cause.message));
  }

  /** After a call is over (ended or skipped): the next call, or the end of the session. */
  function afterCall(view: SessionView, call: number) {
    if (call + 1 < view.calls.length) {
      setScreen({ kind: "brief", view, call: call + 1 });
      return;
    }
    if (skipped.current.size > 0 && participant !== null) {
      post<Progress>("/api/sessions/close", { participant, session: view.session })
        .then((progress) => setScreen({ kind: "closed", progress }))
        .catch((cause: Error) => setError(cause.message));
      return;
    }
    setScreen({ kind: "questionnaire", view });
  }

  function skip(view: SessionView, call: number) {
    const token = view.calls[call]?.token;
    if (token) {
      skipped.current.add(token);
      reportCall(token, "skipped");
    }
    afterCall(view, call);
  }

  if (screen.kind === "loading") return <CenterCard>Loading…</CenterCard>;

  if (screen.kind === "signin") {
    return (
      <SignIn
        onSignedIn={(progress) => {
          setParticipant(progress.participant);
          setScreen({ kind: "home", progress });
        }}
      />
    );
  }

  if (screen.kind === "home" || screen.kind === "closed") {
    const { progress } = screen;
    return (
      <CenterCard>
        <Heading title={progress.canContinue ? "Ready for a session?" : "All done — thank you"}>
          {screen.kind === "closed" && <p className="mb-2">That session had a call that didn't work, so we've set it aside.</p>}
          {progress.canContinue
            ? `You've finished ${progress.completed} of ${progress.total} sessions. Each one is two short calls and a few questions. Doing more sessions helps the most.`
            : `You've finished all ${progress.total} sessions. Thanks for your help.`}
        </Heading>
        <ErrorLine error={error} />
        {progress.canContinue && (
          <Button onClick={startSession}>
            {progress.open ? "Resume" : "Start"} session {progress.completed + 1}
          </Button>
        )}
        <Button
          kind="quiet"
          onClick={() => {
            rememberParticipant(null);
            setParticipant(null);
            setScreen({ kind: "signin" });
          }}
        >
          Not you? Sign out
        </Button>
      </CenterCard>
    );
  }

  if (screen.kind === "brief") {
    const { view, call } = screen;
    const current = view.calls[call];
    if (!current) return null;
    return (
      <CenterCard>
        <Heading title={`Session ${view.index} of ${view.total} · Call ${call + 1} of 2`}>
          You're phoning the Harborlight Hotel to book a room. Play the person on this card — give
          your name, spell your last name, and give the night and address when asked. You don't need
          to read it word for word.
        </Heading>
        <PersonaCard card={current.card} />
        <Button onClick={() => setScreen({ kind: "call", view, call, attempt: 1 })}>
          Start call {call + 1}
        </Button>
      </CenterCard>
    );
  }

  if (screen.kind === "call") {
    const { view, call, attempt } = screen;
    const current = view.calls[call];
    if (!current) return null;
    return (
      <LiveCall
        key={`${current.token}-${attempt}`}
        participant={participant ?? ""}
        call={current}
        label={`Call ${call + 1} of 2`}
        onEnded={() => {
          reportCall(current.token, "completed");
          afterCall(view, call);
        }}
        onDropped={() => {
          reportCall(current.token, "dropped");
          setScreen({ kind: "dropped", view, call, attempt });
        }}
        onSkipped={() => skip(view, call)}
      />
    );
  }

  if (screen.kind === "dropped") {
    const { view, call, attempt } = screen;
    return (
      <CenterCard>
        <Heading title="The call dropped">
          Sorry about that. You can try the call again from the start, or skip it if it keeps
          failing.
        </Heading>
        <div className="flex flex-wrap justify-between gap-3">
          <Button kind="quiet" onClick={() => skip(view, call)}>
            Skip this call
          </Button>
          <Button onClick={() => setScreen({ kind: "call", view, call, attempt: attempt + 1 })}>
            Try again
          </Button>
        </div>
      </CenterCard>
    );
  }

  return (
    <Questionnaire
      participant={participant ?? ""}
      view={screen.view}
      onDone={(progress) => setScreen({ kind: "home", progress })}
    />
  );
}

const isAdmin = location.pathname === "/admin";
document.title = isAdmin ? "Study admin" : "Hotel desk listening test";

const target = document.getElementById("app");
// No StrictMode: it runs effects twice in development, which would dial every call twice.
if (target) createRoot(target).render(isAdmin ? <AdminApp /> : <StudyApp />);
