/**
 * What the admin page shows: progress, head-to-head tallies, call health by
 * system, and the most recent sessions with their transcripts.
 *
 * Built from the same dump and the same rules as the export (`study/export.ts`)
 * — the setup-failure rule, the read-back check, the rehearsal/test filter — so
 * the page and the CSVs can never disagree about what counts. The tallies here
 * are raw counts for keeping an eye on a running study; the Elo ratings and
 * their intervals are the analysis script's job.
 */
import { COMPETITORS, type Competitor, type System, SYSTEMS } from "./design.ts";
import { callFailure, included, indexDump, median, participantId, SLOW_LLM_MS } from "./export.ts";
import type { ReadbackResult } from "./readback.ts";
import type { Ratings, StudyDump } from "./store.ts";

export interface AdminSummary {
  generatedAt: string;
  includeAll: boolean;
  /** Rehearsal or smoke-test sessions left out by the current filter. */
  hiddenSessions: number;
  totals: {
    participants: number;
    sessions: number;
    /** Answered, or closed after a skipped call. */
    finished: number;
    answered: number;
    scored: number;
    setupFailures: Record<string, number>;
  };
  headToHead: {
    competitor: Competitor;
    sessions: number;
    /** Scored and answered: what the analysis fits. */
    compared: number;
    oursWins: number;
    ties: number;
    competitorWins: number;
    /** Mean preference re-signed so + favours ours, −2…+2. */
    meanForOurs: number | null;
    oursFirstShare: number | null;
  }[];
  ratings: { system: System; n: number; naturalness: number | null; tone: number | null; accuracy: number | null }[];
  systems: {
    system: System;
    calls: number;
    connected: number;
    spoke: number;
    completed: number;
    skipped: number;
    drops: number;
    fatalTts: number;
    readbackChecked: number;
    readbackOk: number;
    medianLlmFirstWordMs: number | null;
    medianTtsFirstSoundMs: number | null;
    slowTurns: number;
  }[];
  recent: RecentSession[];
}

export interface RecentSession {
  session: string;
  participant: string;
  email: string;
  index: number;
  createdAt: string;
  competitor: Competitor;
  voice: string;
  oursFirst: boolean;
  rehearsal: boolean;
  test: boolean;
  preference: number | null;
  reasons: string[];
  comment: string | null;
  scored: boolean;
  failure: string | null;
  calls: {
    position: number;
    system: System;
    cellSource: string;
    attempts: number;
    drops: number;
    completed: boolean;
    skipped: boolean;
    failure: string | null;
    fatalError: string | null;
    readback: ReadbackResult | null;
    ratings: Ratings | null;
    agent: string[];
    caller: string[];
  }[];
}

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;

export function adminSummary(dump: StudyDump, options: { includeAll?: boolean; recent?: number } = {}): AdminSummary {
  const includeAll = options.includeAll === true;
  const ix = indexDump(dump);

  const sessions = dump.sessions.filter((s) =>
    included(s, ix.participants.get(s.participantNumber)?.isTest ?? false, { includeAll }),
  );
  const hiddenSessions = dump.sessions.length - sessions.length;

  const setupFailures: Record<string, number> = {};
  const h2h = new Map(
    COMPETITORS.map((c) => [c, { sessions: 0, compared: 0, oursWins: 0, ties: 0, competitorWins: 0, prefs: [] as number[], oursFirst: 0 }]),
  );
  const ratingsBy = new Map(SYSTEMS.map((s) => [s, [] as Ratings[]]));
  const health = new Map(
    SYSTEMS.map((s) => [
      s,
      { calls: 0, connected: 0, spoke: 0, completed: 0, skipped: 0, drops: 0, fatalTts: 0, readbackChecked: 0, readbackOk: 0, llm: [] as number[], tts: [] as number[], slowTurns: 0 },
    ]),
  );
  let answered = 0;
  let scored = 0;
  let finished = 0;
  const recent: RecentSession[] = [];

  for (const session of sessions) {
    const participant = ix.participants.get(session.participantNumber);
    const calls = ix.callsBySession.get(session.id) ?? [];
    const response = ix.responses.get(session.id);
    const failure = calls.length === 2 ? (calls.map(callFailure).find((r) => r !== null) ?? null) : "missing_call";
    const isScored = failure === null;
    if (session.completedAt !== null) finished++;
    if (response) answered++;
    if (isScored) scored++;
    else setupFailures[failure] = (setupFailures[failure] ?? 0) + 1;

    const tally = h2h.get(session.competitor);
    if (tally) {
      tally.sessions++;
      if (session.oursFirst) tally.oursFirst++;
      if (isScored && response) {
        tally.compared++;
        const forOurs = session.oursFirst ? -response.preference : response.preference;
        tally.prefs.push(forOurs);
        if (forOurs > 0) tally.oursWins++;
        else if (forOurs < 0) tally.competitorWins++;
        else tally.ties++;
      }
    }

    for (const call of calls) {
      const h = health.get(call.system);
      const readback = ix.readback(call);
      const turns = ix.turnsByCall.get(call.token) ?? [];
      if (h) {
        h.calls++;
        if (call.connected) h.connected++;
        if (call.spoke) h.spoke++;
        if (call.completed) h.completed++;
        if (call.skipped) h.skipped++;
        h.drops += call.drops;
        if (call.fatalTts) h.fatalTts++;
        if (readback) {
          h.readbackChecked++;
          if (readback.ok) h.readbackOk++;
        }
        for (const t of turns) {
          if (t.modelFirstWordMs !== null) h.llm.push(t.modelFirstWordMs);
          if (t.voiceFirstSoundMs !== null) h.tts.push(t.voiceFirstSoundMs);
          if ((t.modelFirstWordMs ?? 0) > SLOW_LLM_MS) h.slowTurns++;
        }
      }
      if (response && isScored) {
        const r = call.position === 1 ? response.call1 : response.call2;
        ratingsBy.get(call.system)?.push(r);
      }
    }

    recent.push({
      session: session.id,
      participant: participantId(session.participantNumber),
      email: participant?.email ?? "",
      index: session.index,
      createdAt: session.createdAt.toISOString(),
      competitor: session.competitor,
      voice: session.voice,
      oursFirst: session.oursFirst,
      rehearsal: session.rehearsal,
      test: participant?.isTest ?? false,
      preference: response?.preference ?? null,
      reasons: response ? [...response.reasons] : [],
      comment: response?.comment ?? null,
      scored: isScored,
      failure,
      calls: calls.map((call) => {
        const said = ix.transcripts.get(call.token);
        return {
          position: call.position,
          system: call.system,
          cellSource: call.cellSource,
          attempts: call.attempts,
          drops: call.drops,
          completed: call.completed,
          skipped: call.skipped,
          failure: callFailure(call),
          fatalError: call.fatalError,
          readback: ix.readback(call),
          ratings: response ? (call.position === 1 ? response.call1 : response.call2) : null,
          agent: said?.agent ?? [],
          caller: said?.caller ?? [],
        };
      }),
    });
  }

  recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const participants = new Set(sessions.map((s) => s.participantNumber));

  return {
    generatedAt: new Date().toISOString(),
    includeAll,
    hiddenSessions,
    totals: {
      participants: participants.size,
      sessions: sessions.length,
      finished,
      answered,
      scored,
      setupFailures,
    },
    headToHead: COMPETITORS.map((competitor) => {
      const t = h2h.get(competitor) ?? { sessions: 0, compared: 0, oursWins: 0, ties: 0, competitorWins: 0, prefs: [], oursFirst: 0 };
      return {
        competitor,
        sessions: t.sessions,
        compared: t.compared,
        oursWins: t.oursWins,
        ties: t.ties,
        competitorWins: t.competitorWins,
        meanForOurs: mean(t.prefs),
        oursFirstShare: t.sessions === 0 ? null : Math.round((t.oursFirst / t.sessions) * 100) / 100,
      };
    }),
    ratings: SYSTEMS.map((system) => {
      const rs = ratingsBy.get(system) ?? [];
      return {
        system,
        n: rs.length,
        naturalness: mean(rs.map((r) => r.naturalness)),
        tone: mean(rs.map((r) => r.tone)),
        accuracy: mean(rs.map((r) => r.accuracy)),
      };
    }),
    systems: SYSTEMS.map((system) => {
      const h = health.get(system);
      return {
        system,
        calls: h?.calls ?? 0,
        connected: h?.connected ?? 0,
        spoke: h?.spoke ?? 0,
        completed: h?.completed ?? 0,
        skipped: h?.skipped ?? 0,
        drops: h?.drops ?? 0,
        fatalTts: h?.fatalTts ?? 0,
        readbackChecked: h?.readbackChecked ?? 0,
        readbackOk: h?.readbackOk ?? 0,
        medianLlmFirstWordMs: median(h?.llm ?? []),
        medianTtsFirstSoundMs: median(h?.tts ?? []),
        slowTurns: h?.slowTurns ?? 0,
      };
    }),
    recent: recent.slice(0, options.recent ?? 50),
  };
}
