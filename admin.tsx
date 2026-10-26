import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { AdminSummary, RecentSession } from "./study/admin.ts";
import type { MatchingView } from "./study/api.ts";
import type { Competitor, CompetitorWeights } from "./study/design.ts";

/**
 * Spelled out here rather than imported: a value import of `study/design.ts`
 * would ship the schedule into the participants' bundle. Types only cross over.
 */
const COMPETITORS: readonly Competitor[] = ["cartesia", "elevenlabs", "inworld"];

/**
 * The admin page, at `/admin` — for whoever runs the study, never participants.
 *
 * It asks for `STUDY_ADMIN_PASSWORD` once and keeps it for the browser tab only
 * (sessionStorage), sending it as a Bearer header — never in a URL, so it does
 * not land in history or logs. Everything shown comes from
 * `GET /api/admin/summary` (`study/admin.ts`); the CSV buttons fetch the same
 * exports the analysis reads.
 *
 * Rehearsal sessions (stock voices or a stand-in) and smoke-test sign-ins are
 * hidden by default, as in the export; the toggle shows them, marked.
 */

const PASSWORD_KEY = "harborlight.admin";

function storedPassword(): string | null {
  try {
    return sessionStorage.getItem(PASSWORD_KEY);
  } catch {
    return null;
  }
}

function storePassword(password: string | null): void {
  try {
    if (password === null) sessionStorage.removeItem(PASSWORD_KEY);
    else sessionStorage.setItem(PASSWORD_KEY, password);
  } catch {
    // Blocked storage: the password lasts as long as the page instead.
  }
}

class Unauthorized extends Error {}

async function fetchSummary(password: string, includeAll: boolean): Promise<AdminSummary> {
  const response = await fetch(`/api/admin/summary${includeAll ? "?all=1" : ""}`, {
    headers: { authorization: `Bearer ${password}` },
  });
  if (response.status === 401) throw new Unauthorized("wrong password");
  const payload = (await response.json()) as AdminSummary & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `the server answered ${response.status}`);
  return payload;
}

async function adminJson<T>(password: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${password}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401) throw new Unauthorized("wrong password");
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `the server answered ${response.status}`);
  return payload;
}

async function downloadCsv(password: string, kind: "sessions" | "calls", includeAll: boolean): Promise<void> {
  const response = await fetch(`/api/export/${kind}.csv${includeAll ? "?all=1" : ""}`, {
    headers: { authorization: `Bearer ${password}` },
  });
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `${kind}${includeAll ? "-all" : ""}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------

const SYSTEM_LABEL: Record<string, string> = {
  ours: "Ours",
  cartesia: "Cartesia",
  elevenlabs: "ElevenLabs",
  inworld: "Inworld",
};

const FAILURE_LABEL: Record<string, string> = {
  call_never_connected: "Never connected",
  skipped_failing: "Skipped as failing",
  never_spoke: "Never spoke",
  only_dropped: "Only dropped",
  missing_call: "Missing call",
};

const PREFERENCE_LABEL: Record<number, string> = {
  [-2]: "Call 1, clearly",
  [-1]: "Call 1, slightly",
  0: "No preference",
  1: "Call 2, slightly",
  2: "Call 2, clearly",
};

const pct = (part: number, whole: number) => (whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`);
const num = (value: number | null, suffix = "") => (value === null ? "—" : `${value}${suffix}`);
const signed = (value: number | null) => (value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`);

// ---------------------------------------------------------------------------
// Pieces.
// ---------------------------------------------------------------------------

function Panel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-aai-surface p-5 shadow-lg">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {note && <p className="text-xs opacity-60">{note}</p>}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-aai-border bg-aai-bg p-4">
      <span className="text-xs uppercase tracking-wider opacity-60">{label}</span>
      <span className="text-2xl font-bold tabular-nums">{value}</span>
      {sub && <span className="text-xs opacity-60">{sub}</span>}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-aai-border text-left text-xs uppercase tracking-wider opacity-60">
            {head.map((h, i) => (
              <th key={h} className={`py-2 pr-4 font-medium ${i > 0 ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-aai-border/50 last:border-0">
              {row.map((cell, i) => (
                <td key={i} className={`py-2 pr-4 tabular-nums ${i > 0 ? "text-right" : "font-medium"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Ours wins / ties / competitor wins as one stacked bar. */
function WinBar({ ours, ties, theirs }: { ours: number; ties: number; theirs: number }) {
  const total = ours + ties + theirs;
  if (total === 0) return <span className="opacity-40">—</span>;
  return (
    <div className="ml-auto flex h-2.5 w-32 overflow-hidden rounded-full bg-aai-bg" title={`${ours} / ${ties} / ${theirs}`}>
      <div className="bg-aai-primary" style={{ width: `${(ours / total) * 100}%` }} />
      <div className="bg-aai-border" style={{ width: `${(ties / total) * 100}%` }} />
      <div className="bg-sky-400" style={{ width: `${(theirs / total) * 100}%` }} />
    </div>
  );
}

function Tag({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "warn" | "good" | "bad" }) {
  const look = {
    plain: "border-aai-border opacity-70",
    warn: "border-amber-400/60 text-amber-300",
    good: "border-green-400/60 text-green-300",
    bad: "border-red-400/60 text-red-300",
  }[tone];
  return <span className={`rounded-md border px-1.5 py-0.5 text-xs ${look}`}>{children}</span>;
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return <Tag tone={ok ? "good" : "bad"}>{`${ok ? "✓" : "✗"} ${label}`}</Tag>;
}

/**
 * The competitor weights. Ours is in every session; these decide which
 * competitor it is paired with. Equal weights run the protocol's balanced block;
 * anything else steers new sessions toward the target shares.
 */
function MatchingPanel({ password, onError }: { password: string; onError: (message: string) => void }) {
  const [view, setView] = useState<MatchingView | null>(null);
  const [draft, setDraft] = useState<CompetitorWeights | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    adminJson<MatchingView>(password, "/api/admin/matching")
      .then((next) => {
        setView(next);
        setDraft(next.weights);
      })
      .catch((e: Error) => onError(e.message));
  }, [password, onError]);

  if (view === null || draft === null) return null;

  const total = COMPETITORS.reduce((sum, c) => sum + (draft[c] || 0), 0);
  const share = (c: (typeof COMPETITORS)[number]) => (total === 0 ? 0 : (draft[c] || 0) / total);
  const changed = COMPETITORS.some((c) => draft[c] !== view.weights[c]);
  const valid = total > 0 && COMPETITORS.every((c) => draft[c] >= 0 && draft[c] <= 100);
  const sinceTotal = COMPETITORS.reduce((sum, c) => sum + view.sinceChange[c], 0);

  function save(weights: CompetitorWeights) {
    setSaving(true);
    adminJson<MatchingView>(password, "/api/admin/matching", { weights })
      .then((next) => {
        setView(next);
        setDraft(next.weights);
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => setSaving(false));
  }

  return (
    <Panel
      title="Matching"
      note="Ours is in every session; these weights decide which competitor it faces. Equal weights run the protocol's balanced six-session block. Unequal weights steer new sessions to the target shares (the comparison you most need to resolve, say), and 0 takes a competitor out — e.g. while its provider is down. Call order stays counterbalanced either way."
    >
      <div className="flex flex-wrap items-end gap-4">
        {COMPETITORS.map((c) => (
          <label key={c} className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Ours vs {SYSTEM_LABEL[c]}</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={Number.isNaN(draft[c]) ? "" : draft[c]}
                onChange={(e) => setDraft({ ...draft, [c]: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
                className="w-20 rounded-lg border border-aai-border bg-aai-bg px-2 py-1.5 text-right tabular-nums outline-none focus:border-aai-primary"
              />
              <span className="w-12 text-xs tabular-nums opacity-60">{Math.round(share(c) * 100)}%</span>
            </div>
          </label>
        ))}
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            disabled={saving || view.balanced}
            onClick={() => save({ cartesia: 1, elevenlabs: 1, inworld: 1 })}
            className="rounded-lg border border-aai-border px-3 py-2 text-sm disabled:opacity-40"
          >
            Reset to balanced
          </button>
          <button
            type="button"
            disabled={saving || !changed || !valid}
            onClick={() => save(draft)}
            className="rounded-lg bg-aai-primary px-3 py-2 text-sm font-semibold text-aai-bg disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save weights"}
          </button>
        </div>
      </div>
      <p className="text-xs opacity-70">
        {view.balanced ? "Now: balanced block (protocol default)." : "Now: weighted."}{" "}
        {view.changedAt === null
          ? "Never changed."
          : `Since the last change (${new Date(view.changedAt).toLocaleString()}), ${sinceTotal} study session(s): ` +
            COMPETITORS.map(
              (c) =>
                `${SYSTEM_LABEL[c]} ${view.sinceChange[c]} (${sinceTotal === 0 ? 0 : Math.round((view.sinceChange[c] / sinceTotal) * 100)}%, target ${Math.round(view.targetShare[c] * 100)}%)`,
            ).join(" · ")}
      </p>
    </Panel>
  );
}

function SessionRow({ session }: { session: RecentSession }) {
  const [open, setOpen] = useState(false);
  const ours = session.oursFirst ? 1 : 2;
  return (
    <li className="rounded-xl border border-aai-border bg-aai-bg">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left text-sm"
      >
        <span className="w-36 shrink-0 opacity-60">{new Date(session.createdAt).toLocaleString()}</span>
        <span className="w-48 shrink-0 truncate" title={session.email}>
          {session.participant} · {session.email}
        </span>
        <span className="shrink-0">Session {session.index}</span>
        <span className="shrink-0">
          Ours vs {SYSTEM_LABEL[session.competitor]} · {session.voice} · ours was call {ours}
        </span>
        <span className="ml-auto flex shrink-0 flex-wrap gap-1.5">
          {session.rehearsal && <Tag tone="warn">rehearsal</Tag>}
          {session.test && <Tag tone="warn">test sign-in</Tag>}
          {session.failure ? (
            <Tag tone="bad">{FAILURE_LABEL[session.failure] ?? session.failure}</Tag>
          ) : session.preference !== null ? (
            <Tag tone="good">{PREFERENCE_LABEL[session.preference]}</Tag>
          ) : (
            <Tag>no answer yet</Tag>
          )}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t border-aai-border px-4 py-4 text-sm">
          {(session.reasons.length > 0 || session.comment) && (
            <p>
              <span className="opacity-60">Reasons:</span> {session.reasons.join(", ") || "—"}
              {session.comment && (
                <>
                  {" "}
                  <span className="opacity-60">· Comment:</span> “{session.comment}”
                </>
              )}
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            {session.calls.map((call) => (
              <div key={call.position} className="flex flex-col gap-2 rounded-lg border border-aai-border p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold">
                    Call {call.position} · {SYSTEM_LABEL[call.system]}
                  </span>
                  {call.cellSource !== "clone" && <Tag tone="warn">{call.cellSource} voice</Tag>}
                  {call.failure && <Tag tone="bad">{FAILURE_LABEL[call.failure] ?? call.failure}</Tag>}
                  {call.attempts > 1 && <Tag>{call.attempts} attempts</Tag>}
                  {call.drops > 0 && <Tag tone="warn">{call.drops} drop(s)</Tag>}
                </div>
                {call.ratings && (
                  <p className="text-xs opacity-80">
                    Naturalness {call.ratings.naturalness} · Tone {call.ratings.tone} · Accuracy {call.ratings.accuracy}
                  </p>
                )}
                {call.readback && (
                  <div className="flex flex-wrap gap-1.5">
                    <Check ok={call.readback.name} label="name" />
                    <Check ok={call.readback.night} label="night" />
                    <Check ok={call.readback.address} label="address" />
                  </div>
                )}
                {call.fatalError && <p className="text-xs text-red-300">{call.fatalError}</p>}
                <Transcript agent={call.agent} caller={call.caller} />
              </div>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Both sides of a call. The two lists are saved separately, so they are shown
 * as two columns rather than interleaved in an order we do not actually know.
 */
function Transcript({ agent, caller }: { agent: string[]; caller: string[] }) {
  if (agent.length === 0 && caller.length === 0) return <p className="text-xs opacity-50">No transcript.</p>;
  return (
    <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
      {(
        [
          ["Agent", agent],
          ["Caller", caller],
        ] as const
      ).map(([who, lines]) => (
        <div key={who} className="flex flex-col gap-1">
          <span className="font-semibold opacity-60">{who}</span>
          {lines.length === 0 ? (
            <span className="opacity-50">—</span>
          ) : (
            lines.map((line, i) => (
              <p key={i} className="leading-relaxed">
                {line}
              </p>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------

function SignIn({ onPassword, error }: { onPassword: (password: string) => void; error: string | null }) {
  const [password, setPassword] = useState("");
  return (
    <main className="flex min-h-screen items-center justify-center bg-aai-bg p-4 text-aai-text">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-aai-surface p-6 shadow-lg"
        onSubmit={(event) => {
          event.preventDefault();
          if (password) onPassword(password);
        }}
      >
        <h1 className="text-2xl font-bold">Study admin</h1>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Admin password
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="rounded-lg border border-aai-border bg-aai-bg px-3 py-2 text-base text-aai-text outline-none focus:border-aai-primary"
          />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={!password}
          className="rounded-lg bg-aai-primary px-4 py-2.5 font-semibold text-aai-bg disabled:opacity-40"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}

export function AdminApp() {
  const [password, setPassword] = useState<string | null>(storedPassword);
  const [includeAll, setIncludeAll] = useState(false);
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (password === null) return;
    setLoading(true);
    fetchSummary(password, includeAll)
      .then((next) => {
        storePassword(password);
        setSummary(next);
        setError(null);
      })
      .catch((cause: Error) => {
        if (cause instanceof Unauthorized) {
          storePassword(null);
          setPassword(null);
        }
        setError(cause.message);
      })
      .finally(() => setLoading(false));
  }, [password, includeAll]);

  useEffect(load, [load]);

  if (password === null) return <SignIn onPassword={setPassword} error={error} />;
  if (summary === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-aai-bg p-4 text-aai-text">
        {error ?? "Loading…"}
      </main>
    );
  }

  const { totals } = summary;
  const failures = Object.values(totals.setupFailures).reduce((a, b) => a + b, 0);

  return (
    <main className="min-h-screen bg-aai-bg p-4 text-aai-text sm:p-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h1 className="text-2xl font-bold">Hotel desk blind test · admin</h1>
            <p className="text-xs opacity-60">Updated {new Date(summary.generatedAt).toLocaleTimeString()}</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeAll} onChange={(e) => setIncludeAll(e.target.checked)} />
            Include rehearsal &amp; test
          </label>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded-lg border border-aai-border px-3 py-2 text-sm disabled:opacity-40"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          {(["sessions", "calls"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => downloadCsv(password, kind, includeAll).catch((e: Error) => setError(e.message))}
              className="rounded-lg bg-aai-primary px-3 py-2 text-sm font-semibold text-aai-bg"
            >
              {kind === "sessions" ? "Sessions CSV" : "Calls CSV"}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              storePassword(null);
              setPassword(null);
              setSummary(null);
            }}
            className="text-sm opacity-60"
          >
            Sign out
          </button>
        </header>

        {error && <p className="text-sm text-red-400">{error}</p>}
        {!summary.includeAll && summary.hiddenSessions > 0 && (
          <p className="rounded-lg border border-amber-400/40 px-4 py-2 text-sm text-amber-200">
            {summary.hiddenSessions} rehearsal or test session(s) hidden. Tick “Include rehearsal &amp; test” to see
            them.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Participants" value={totals.participants} />
          <Stat label="Sessions" value={totals.sessions} sub={`${totals.finished} finished`} />
          <Stat label="Answered" value={totals.answered} />
          <Stat label="Scored" value={totals.scored} sub="no setup failure" />
          <Stat
            label="Setup failures"
            value={failures}
            sub={
              failures === 0
                ? "none"
                : Object.entries(totals.setupFailures)
                    .map(([reason, n]) => `${FAILURE_LABEL[reason] ?? reason}: ${n}`)
                    .join(" · ")
            }
          />
        </div>

        <MatchingPanel password={password} onError={setError} />

        <Panel
          title="Head to head"
          note="Scored, answered sessions. Mean preference runs −2…+2, re-signed so + favours ours. Raw tallies only — run analysis/analyze.py on the sessions CSV for Elo and intervals."
        >
          <Table
            head={["Ours vs", "Sessions", "Compared", "Ours / tie / them", "", "Mean pref", "Ours first"]}
            rows={summary.headToHead.map((h) => [
              SYSTEM_LABEL[h.competitor],
              h.sessions,
              h.compared,
              `${h.oursWins} / ${h.ties} / ${h.competitorWins}`,
              <WinBar ours={h.oursWins} ties={h.ties} theirs={h.competitorWins} />,
              signed(h.meanForOurs),
              h.oursFirstShare === null ? "—" : `${Math.round(h.oursFirstShare * 100)}%`,
            ])}
          />
        </Panel>

        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title="Ratings by system" note="Mean 1–5 per call, from scored sessions.">
            <Table
              head={["System", "Calls", "Natural", "Tone", "Accuracy"]}
              rows={summary.ratings.map((r) => [SYSTEM_LABEL[r.system], r.n, num(r.naturalness), num(r.tone), num(r.accuracy)])}
            />
          </Panel>
          <Panel title="Call health by system" note="All calls in the filter, scored or not.">
            <Table
              head={["System", "Calls", "Spoke", "Drops", "Fatal TTS", "Read-back", "LLM p50", "TTS p50"]}
              rows={summary.systems.map((s) => [
                SYSTEM_LABEL[s.system],
                s.calls,
                pct(s.spoke, s.calls),
                s.drops,
                s.fatalTts,
                s.readbackChecked === 0 ? "—" : `${s.readbackOk}/${s.readbackChecked}`,
                num(s.medianLlmFirstWordMs, " ms"),
                num(s.medianTtsFirstSoundMs, " ms"),
              ])}
            />
          </Panel>
        </div>

        <Panel title="Recent sessions" note="Newest first, up to 50. Click a session for its calls and transcripts.">
          {summary.recent.length === 0 ? (
            <p className="text-sm opacity-60">No sessions yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {summary.recent.map((session) => (
                <SessionRow key={session.session} session={session} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </main>
  );
}
