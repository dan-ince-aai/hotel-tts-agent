/**
 * The export: one row per session, in exactly the columns
 * `analysis/analyze.py` reads, plus a per-call CSV for reviewing calls by hand.
 *
 * ## What counts
 *
 * - **Never study data:** rehearsal sessions (a stand-in or stock voices on the
 *   server) and smoke-test sign-ins. They are left out unless `includeAll` is
 *   set, and then marked in extra `rehearsal` / `test_participant` columns the
 *   analysis ignores.
 * - **Setup failures are counted, not scored.** A session is unscored if either
 *   call never connected, was skipped as failing, never spoke, or only ever
 *   dropped. A call that dropped and was retried to the end counts. Model defects
 *   — a slow reply, a wrong read-back, a mid-call TTS error — stay in.
 *
 * ## The flags the sensitivity fits use
 *
 * - `ck_slow_llm` — any reply in the session whose LLM took over 2.4 s to its
 *   first word (the dead-air threshold the filler would have covered).
 * - `fatal_tts_ours` / `fatal_tts_competitor` — a fatal TTS error on that
 *   system's call.
 * - `readback_ok_ours` / `readback_ok_competitor` — the automatic read-back
 *   check (`study/readback.ts`) on each call; blank when there is no transcript.
 */
import { cardById } from "./cards.ts";
import { checkReadback, type ReadbackResult } from "./readback.ts";
import type { StudyCall, StudyDump, StudySession } from "./store.ts";

/** The LLM first-word time above which a session is flagged `ck_slow_llm`. */
export const SLOW_LLM_MS = 2400;

/** The analysis input's columns, in order. */
export const SESSION_COLUMNS = [
  "participant_id",
  "session_id",
  "session_index",
  "created_at",
  "competitor",
  "voice",
  "ours_call",
  "preference",
  "reasons",
  "comment",
  "call1_naturalness",
  "call1_tone",
  "call1_accuracy",
  "call2_naturalness",
  "call2_tone",
  "call2_accuracy",
  "scored",
  "setup_failure_reason",
  "fatal_tts_ours",
  "fatal_tts_competitor",
  "ck_slow_llm",
  "readback_ok_ours",
  "readback_ok_competitor",
] as const;

export const CALL_COLUMNS = [
  "participant_id",
  "session_id",
  "session_index",
  "position",
  "system",
  "voice",
  "cell",
  "provider",
  "voice_id",
  "cell_source",
  "card_id",
  "attempts",
  "connected",
  "spoke",
  "drops",
  "skipped",
  "completed",
  "fatal_tts",
  "fatal_error",
  "setup_failure_reason",
  "turns",
  "median_whole_turn_ms",
  "median_llm_first_word_ms",
  "median_tts_first_sound_ms",
  "max_llm_first_word_ms",
  "readback_name",
  "readback_night",
  "readback_address",
  "agent_transcript",
  "caller_transcript",
] as const;

type Cell = string | number | boolean | null | undefined;
type Row = Record<string, Cell>;

export interface ExportOptions {
  /** Include rehearsal sessions and smoke-test participants, marked. */
  includeAll?: boolean;
}

/** Why a call is a setup failure, or `null` if it is not one. Order matters. */
export function callFailure(call: StudyCall): string | null {
  if (!call.connected) return "call_never_connected";
  if (call.skipped) return "skipped_failing";
  if (!call.spoke) return "never_spoke";
  if (call.drops > 0 && !call.completed) return "only_dropped";
  return null;
}

export function participantId(number: number): string {
  return `p${String(number).padStart(4, "0")}`;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** Everything the export (and the admin page) needs, indexed once. */
export function indexDump(dump: StudyDump) {
  const participants = new Map(dump.participants.map((p) => [p.number, p]));
  const callsBySession = new Map<string, StudyCall[]>();
  for (const call of dump.calls) {
    const list = callsBySession.get(call.sessionId) ?? [];
    list.push(call);
    callsBySession.set(call.sessionId, list);
  }
  for (const list of callsBySession.values()) list.sort((a, b) => a.position - b.position);
  const responses = new Map(dump.responses.map((r) => [r.sessionId, r]));
  const turnsByCall = new Map<string, StudyDump["turns"]>();
  for (const turn of dump.turns) {
    if (turn.callToken === null) continue;
    const list = turnsByCall.get(turn.callToken) ?? [];
    list.push(turn);
    turnsByCall.set(turn.callToken, list);
  }
  const transcripts = new Map<string, { agent: string[]; caller: string[] }>();
  for (const u of dump.utterances) {
    const entry = transcripts.get(u.callToken) ?? { agent: [], caller: [] };
    entry[u.role].push(u.text);
    transcripts.set(u.callToken, entry);
  }
  const readback = (call: StudyCall): ReadbackResult | null => {
    const agent = transcripts.get(call.token)?.agent ?? [];
    const card = cardById(call.cardId);
    return agent.length > 0 && card ? checkReadback(agent, card) : null;
  };
  return { participants, callsBySession, responses, turnsByCall, transcripts, readback };
}

export function included(session: StudySession, isTest: boolean, options: ExportOptions): boolean {
  return options.includeAll === true || (!session.rehearsal && !isTest);
}

/** One row per session — the analysis input. */
export function sessionRows(dump: StudyDump, options: ExportOptions = {}): Row[] {
  const ix = indexDump(dump);
  const rows: Row[] = [];
  for (const session of dump.sessions) {
    const participant = ix.participants.get(session.participantNumber);
    const isTest = participant?.isTest ?? false;
    if (!included(session, isTest, options)) continue;
    const calls = ix.callsBySession.get(session.id) ?? [];
    const ours = calls.find((c) => c.system === "ours");
    const theirs = calls.find((c) => c.system !== "ours");
    const failure = calls.map(callFailure).find((reason) => reason !== null) ?? null;
    const response = ix.responses.get(session.id);
    const slow = calls.some((call) =>
      (ix.turnsByCall.get(call.token) ?? []).some((t) => (t.modelFirstWordMs ?? 0) > SLOW_LLM_MS),
    );
    const rbOurs = ours ? ix.readback(ours) : null;
    const rbTheirs = theirs ? ix.readback(theirs) : null;

    const row: Row = {
      participant_id: participantId(session.participantNumber),
      session_id: session.id,
      session_index: session.index,
      created_at: session.createdAt.toISOString(),
      competitor: session.competitor,
      voice: session.voice,
      ours_call: session.oursFirst ? 1 : 2,
      preference: response?.preference,
      reasons: response?.reasons.join(";"),
      comment: response?.comment,
      call1_naturalness: response?.call1.naturalness,
      call1_tone: response?.call1.tone,
      call1_accuracy: response?.call1.accuracy,
      call2_naturalness: response?.call2.naturalness,
      call2_tone: response?.call2.tone,
      call2_accuracy: response?.call2.accuracy,
      // A session missing a call row cannot be scored either.
      scored: failure === null && calls.length === 2,
      setup_failure_reason: calls.length === 2 ? failure : "missing_call",
      fatal_tts_ours: ours?.fatalTts ?? false,
      fatal_tts_competitor: theirs?.fatalTts ?? false,
      ck_slow_llm: slow,
      readback_ok_ours: rbOurs?.ok,
      readback_ok_competitor: rbTheirs?.ok,
    };
    if (options.includeAll) {
      row.rehearsal = session.rehearsal;
      row.test_participant = isTest;
    }
    rows.push(row);
  }
  return rows;
}

/** One row per call — for reviewing calls by hand, with the transcript. */
export function callRows(dump: StudyDump, options: ExportOptions = {}): Row[] {
  const ix = indexDump(dump);
  const rows: Row[] = [];
  for (const session of dump.sessions) {
    const isTest = ix.participants.get(session.participantNumber)?.isTest ?? false;
    if (!included(session, isTest, options)) continue;
    for (const call of ix.callsBySession.get(session.id) ?? []) {
      const turns = ix.turnsByCall.get(call.token) ?? [];
      const pick = (f: (t: (typeof turns)[number]) => number | null) =>
        turns.map(f).filter((v): v is number => v !== null);
      const llm = pick((t) => t.modelFirstWordMs);
      const rb = ix.readback(call);
      const said = ix.transcripts.get(call.token);
      rows.push({
        participant_id: participantId(session.participantNumber),
        session_id: session.id,
        session_index: session.index,
        position: call.position,
        system: call.system,
        voice: session.voice,
        cell: call.cellKey,
        provider: call.provider,
        voice_id: call.voiceId,
        cell_source: call.cellSource,
        card_id: call.cardId,
        attempts: call.attempts,
        connected: call.connected,
        spoke: call.spoke,
        drops: call.drops,
        skipped: call.skipped,
        completed: call.completed,
        fatal_tts: call.fatalTts,
        fatal_error: call.fatalError,
        setup_failure_reason: callFailure(call),
        turns: turns.length,
        median_whole_turn_ms: median(pick((t) => t.wholeTurnMs)),
        median_llm_first_word_ms: median(llm),
        median_tts_first_sound_ms: median(pick((t) => t.voiceFirstSoundMs)),
        max_llm_first_word_ms: llm.length > 0 ? Math.max(...llm) : null,
        readback_name: rb?.name,
        readback_night: rb?.night,
        readback_address: rb?.address,
        agent_transcript: said?.agent.join(" | "),
        caller_transcript: said?.caller.join(" | "),
      });
    }
  }
  return rows;
}

function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows to CSV, columns in the given order (extra row keys appended). */
export function toCsv(columns: readonly string[], rows: Row[]): string {
  const extra = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((k) => !columns.includes(k));
  const all = [...columns, ...extra];
  const lines = [all.join(","), ...rows.map((row) => all.map((c) => csvCell(row[c])).join(","))];
  return `${lines.join("\n")}\n`;
}
