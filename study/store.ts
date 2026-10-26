/**
 * The study's records: who signed in, which sessions they were given, how each
 * call went, what they answered, and how fast every reply was.
 *
 * ## Two stores, one interface
 *
 * {@link StudyStore} is what the API and the server talk to. {@link PostgresStore}
 * is the real one, opened from `DATABASE_URL`. {@link MemoryStore} is the same
 * behaviour in a few Maps — what `npm start` runs on with no database, and what
 * the specs drive — so nothing about the flow needs a database to exercise, and
 * the two cannot drift apart without a spec noticing.
 *
 * ## The rows
 *
 * - `participants` — one per email. `number` is the 0-based sign-up order the
 *   schedule (`study/design.ts`) is drawn from; `token` is the opaque id the page
 *   holds instead of the email.
 * - `study_sessions` — one per session HANDED OUT, finished or not, because the
 *   order balance counts abandoned sessions too. Carries the competitor, voice and
 *   order, which the page never sees.
 * - `calls` — two per session, each with an opaque `token` the browser's socket
 *   presents, the voice cell that speaks it, and the counters the setup-failure
 *   rule reads: connected, spoke, drops, skipped, completed, a fatal TTS error.
 * - `runtime_sessions` — which runtime session id (one per socket) belonged to
 *   which call, since a dropped call retried is a second socket on the same call.
 * - `responses` — the questionnaire, one per session.
 * - `turns` — one per reply, the four speed numbers; blanks, never zeroes, for a
 *   stage that did not happen.
 * - `utterances` — what each side said, committed turn by committed turn. The
 *   read-back check (`study/readback.ts`) reads the agent's side.
 * - `study_settings` — the admin's matching weights, so they survive a restart.
 */
import type { MetricsCollectedEvent } from "@alexkroman1/aai";
import postgres from "postgres";
import { type Competitor, COMPETITORS, type CompetitorWeights, EQUAL_WEIGHTS, type System, type VoiceName } from "./design.ts";

export interface Participant {
  readonly number: number;
  readonly token: string;
  readonly email: string;
  /** A smoke-test sign-in (see {@link isTestEmail}) — never study data. */
  readonly isTest: boolean;
}

export interface StudySession {
  readonly id: string;
  readonly participantNumber: number;
  /** 1…6. */
  readonly index: number;
  readonly competitor: Competitor;
  readonly voice: VoiceName;
  readonly oursFirst: boolean;
  /** Handed out by a server running a stand-in or stock voices — never study data. */
  readonly rehearsal: boolean;
  /** `balanced`: the protocol's block. `weighted`: paired by the admin's weights. */
  readonly allocation: "balanced" | "weighted";
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface StudyCall {
  readonly token: string;
  readonly sessionId: string;
  readonly position: 1 | 2;
  readonly system: System;
  /** `ours:jane` — the engine the server routes this call's socket to. */
  readonly cellKey: string;
  readonly provider: string;
  readonly voiceId: string | null;
  readonly cellSource: "clone" | "standin" | "stock";
  readonly cardId: string;
  readonly attempts: number;
  readonly connected: boolean;
  readonly spoke: boolean;
  readonly drops: number;
  readonly skipped: boolean;
  readonly completed: boolean;
  readonly fatalTts: boolean;
  readonly fatalError: string | null;
}

/** What a new call row needs; the counters all start at zero. */
export type NewCall = Pick<
  StudyCall,
  "token" | "sessionId" | "position" | "system" | "cellKey" | "provider" | "voiceId" | "cellSource" | "cardId"
>;

export interface Ratings {
  readonly naturalness: number;
  readonly tone: number;
  readonly accuracy: number;
}

export interface StudyResponse {
  readonly sessionId: string;
  /** −2 call 1 clearly … 0 no preference … +2 call 2 clearly. */
  readonly preference: number;
  readonly reasons: readonly string[];
  readonly comment: string | null;
  readonly call1: Ratings;
  readonly call2: Ratings;
}

/** A call-lifecycle fact the server or the page reports. */
export type CallEvent =
  | { type: "connected" }
  | { type: "spoke" }
  | { type: "dropped" }
  | { type: "skipped" }
  | { type: "completed" }
  | { type: "fatal"; code: string; message: string };

/** One reply's four speed numbers, each `null` where that stage did not happen. */
export interface TurnTimings {
  /** Committed caller turn → first reply audio (the whole turn). */
  wholeTurnMs: number | null;
  /** Last partial with words → committed final (the end-of-speech pause). */
  endOfSpeechMs: number | null;
  /** Request → the model's first content part (the model's first word). */
  modelFirstWordMs: number | null;
  /** First text into TTS → its first audio (the voice's first sound). */
  voiceFirstSoundMs: number | null;
  /** Whether the reply was cut short. */
  interrupted: boolean;
}

/**
 * Pull the four numbers out of a `metrics.collected` frame, mapping an absent
 * stage to `null` (never zero — a zero averages in as the fast case).
 */
export function turnTimings(event: MetricsCollectedEvent): TurnTimings {
  return {
    wholeTurnMs: event.latencyMs ?? null,
    endOfSpeechMs: event.stt?.endpointingMs ?? null,
    modelFirstWordMs: event.llm?.ttftMs ?? null,
    voiceFirstSoundMs: event.tts?.ttfbMs ?? null,
    interrupted: event.interrupted,
  };
}

/** A saved turn, as the export reads it back. */
export interface TurnRow extends TurnTimings {
  readonly callToken: string | null;
}

/** One committed turn of a call's transcript. */
export interface Utterance {
  readonly callToken: string;
  readonly role: "agent" | "caller";
  readonly text: string;
}

/** The admin's matching weights, and when they last changed. */
export interface MatchingSettings {
  readonly weights: CompetitorWeights;
  /** Shares are counted from here; `null` until the weights are first changed. */
  readonly changedAt: Date | null;
}

export const DEFAULT_MATCHING: MatchingSettings = { weights: EQUAL_WEIGHTS, changedAt: null };

/** Normalise an email for identity: trimmed, lower case. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Smoke-test sign-ins are never study data: an `@example.com` address, or a
 * `+test` tag in the local part (`dana+test@assemblyai.com`).
 */
export function isTestEmail(email: string): boolean {
  const [local = "", domain = ""] = normaliseEmail(email).split("@");
  return domain === "example.com" || /\+test/.test(local);
}

export interface StudyStore {
  /** The participant for this email, created on first sign-in. */
  signIn(email: string, token: string): Promise<Participant>;
  participant(token: string): Promise<Participant | undefined>;
  /** Every session handed to this participant, oldest first. */
  sessions(participantNumber: number): Promise<StudySession[]>;
  session(id: string): Promise<StudySession | undefined>;
  /**
   * Save a session and its two calls together. Rejects if the participant
   * already has a session at that index — two tabs racing to start one.
   */
  createSession(session: Omit<StudySession, "createdAt" | "completedAt">, calls: NewCall[]): Promise<void>;
  calls(sessionId: string): Promise<StudyCall[]>;
  call(token: string): Promise<StudyCall | undefined>;
  recordCallEvent(token: string, event: CallEvent): Promise<void>;
  linkRuntimeSession(runtimeId: string, callToken: string): Promise<void>;
  callForRuntime(runtimeId: string): Promise<string | undefined>;
  recordTurn(runtimeId: string, callToken: string | null, timings: TurnTimings): Promise<void>;
  recordUtterance(runtimeId: string, utterance: Utterance): Promise<void>;
  /** Save the questionnaire and mark the session complete. Rejects a second answer. */
  saveResponse(response: StudyResponse): Promise<void>;
  response(sessionId: string): Promise<StudyResponse | undefined>;
  /**
   * Close a session WITHOUT an answer — a call in it was skipped as failing, so
   * there is nothing fair to compare. It still counts toward the block.
   */
  closeSession(sessionId: string): Promise<void>;
  matching(): Promise<MatchingSettings>;
  /** Save new weights; `changedAt` is set to now. */
  saveMatching(weights: CompetitorWeights): Promise<MatchingSettings>;
  /**
   * Sessions handed out per competitor since `since` (all time if `null`),
   * counting only sessions with this `rehearsal` flag, so rehearsals never skew
   * the shares real sessions are steered toward.
   */
  competitorCounts(since: Date | null, rehearsal: boolean): Promise<Record<Competitor, number>>;
  /** Everything, for the export. */
  dump(): Promise<StudyDump>;
  close(): Promise<void>;
}

export interface StudyDump {
  participants: Participant[];
  sessions: StudySession[];
  calls: StudyCall[];
  responses: StudyResponse[];
  turns: TurnRow[];
  utterances: Utterance[];
}

/** The rule behind the counters, shared by both stores. */
function applyEvent(call: StudyCall, event: CallEvent): StudyCall {
  switch (event.type) {
    case "connected":
      return { ...call, attempts: call.attempts + 1, connected: true };
    case "spoke":
      return { ...call, spoke: true };
    case "dropped":
      return { ...call, drops: call.drops + 1 };
    case "skipped":
      return { ...call, skipped: true };
    case "completed":
      return { ...call, completed: true };
    case "fatal":
      return {
        ...call,
        fatalTts: call.fatalTts || event.code === "tts",
        fatalError: `${event.code}: ${event.message}`.slice(0, 500),
      };
  }
}

// ---------------------------------------------------------------------------
// In memory.
// ---------------------------------------------------------------------------

export class MemoryStore implements StudyStore {
  private readonly participantsByEmail = new Map<string, Participant>();
  private readonly sessionsById = new Map<string, StudySession>();
  private readonly callsByToken = new Map<string, StudyCall>();
  private readonly runtimeToCall = new Map<string, string>();
  private readonly responses = new Map<string, StudyResponse>();
  private readonly turns: TurnRow[] = [];
  private readonly utterances: Utterance[] = [];
  private matchingSettings: MatchingSettings = DEFAULT_MATCHING;

  async signIn(email: string, token: string): Promise<Participant> {
    const key = normaliseEmail(email);
    const existing = this.participantsByEmail.get(key);
    if (existing) return existing;
    const participant = { number: this.participantsByEmail.size, token, email: key, isTest: isTestEmail(key) };
    this.participantsByEmail.set(key, participant);
    return participant;
  }

  async participant(token: string): Promise<Participant | undefined> {
    return [...this.participantsByEmail.values()].find((p) => p.token === token);
  }

  async sessions(participantNumber: number): Promise<StudySession[]> {
    return [...this.sessionsById.values()]
      .filter((s) => s.participantNumber === participantNumber)
      .sort((a, b) => a.index - b.index);
  }

  async session(id: string): Promise<StudySession | undefined> {
    return this.sessionsById.get(id);
  }

  async createSession(
    session: Omit<StudySession, "createdAt" | "completedAt">,
    calls: NewCall[],
  ): Promise<void> {
    const clash = (await this.sessions(session.participantNumber)).some((s) => s.index === session.index);
    if (clash) throw new Error(`participant ${session.participantNumber} already has session ${session.index}`);
    this.sessionsById.set(session.id, { ...session, createdAt: new Date(), completedAt: null });
    for (const call of calls) {
      this.callsByToken.set(call.token, {
        ...call,
        attempts: 0,
        connected: false,
        spoke: false,
        drops: 0,
        skipped: false,
        completed: false,
        fatalTts: false,
        fatalError: null,
      });
    }
  }

  async calls(sessionId: string): Promise<StudyCall[]> {
    return [...this.callsByToken.values()]
      .filter((c) => c.sessionId === sessionId)
      .sort((a, b) => a.position - b.position);
  }

  async call(token: string): Promise<StudyCall | undefined> {
    return this.callsByToken.get(token);
  }

  async recordCallEvent(token: string, event: CallEvent): Promise<void> {
    const call = this.callsByToken.get(token);
    if (call) this.callsByToken.set(token, applyEvent(call, event));
  }

  async linkRuntimeSession(runtimeId: string, callToken: string): Promise<void> {
    this.runtimeToCall.set(runtimeId, callToken);
  }

  async callForRuntime(runtimeId: string): Promise<string | undefined> {
    return this.runtimeToCall.get(runtimeId);
  }

  async recordTurn(_runtimeId: string, callToken: string | null, timings: TurnTimings): Promise<void> {
    this.turns.push({ callToken, ...timings });
  }

  async recordUtterance(_runtimeId: string, utterance: Utterance): Promise<void> {
    this.utterances.push(utterance);
  }

  async saveResponse(response: StudyResponse): Promise<void> {
    const session = this.sessionsById.get(response.sessionId);
    if (!session) throw new Error(`no session ${response.sessionId}`);
    if (this.responses.has(response.sessionId)) throw new Error(`session ${response.sessionId} already answered`);
    this.responses.set(response.sessionId, response);
    this.sessionsById.set(session.id, { ...session, completedAt: new Date() });
  }

  async response(sessionId: string): Promise<StudyResponse | undefined> {
    return this.responses.get(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessionsById.get(sessionId);
    if (session && session.completedAt === null) {
      this.sessionsById.set(sessionId, { ...session, completedAt: new Date() });
    }
  }

  async matching(): Promise<MatchingSettings> {
    return this.matchingSettings;
  }

  async saveMatching(weights: CompetitorWeights): Promise<MatchingSettings> {
    this.matchingSettings = { weights: { ...weights }, changedAt: new Date() };
    return this.matchingSettings;
  }

  async competitorCounts(since: Date | null, rehearsal: boolean): Promise<Record<Competitor, number>> {
    const counts = zeroCounts();
    for (const s of this.sessionsById.values()) {
      if (s.rehearsal === rehearsal && (since === null || s.createdAt >= since)) counts[s.competitor]++;
    }
    return counts;
  }

  async dump(): Promise<StudyDump> {
    return {
      participants: [...this.participantsByEmail.values()],
      sessions: [...this.sessionsById.values()],
      calls: [...this.callsByToken.values()],
      responses: [...this.responses.values()],
      turns: [...this.turns],
      utterances: [...this.utterances],
    };
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Postgres.
// ---------------------------------------------------------------------------

type Sql = ReturnType<typeof postgres>;

/** The advisory-lock key that serialises new participant numbers. */
const PARTICIPANT_LOCK = 0x4842_5450; // "HBTP"

export class PostgresStore implements StudyStore {
  private readonly sql: Sql;

  private constructor(sql: Sql) {
    this.sql = sql;
  }

  /** Open the pool and create the tables. Idempotent: a redeploy is a no-op. */
  static async open(databaseUrl: string): Promise<PostgresStore> {
    // `onnotice` silenced: `create table if not exists` NOTICEs on every redeploy.
    const sql = postgres(databaseUrl, { max: 5, onnotice: () => {} });
    await ensureSchema(sql);
    return new PostgresStore(sql);
  }

  async signIn(email: string, token: string): Promise<Participant> {
    const key = normaliseEmail(email);
    // Participant numbers must be GAPLESS — the schedule balances over runs of
    // consecutive numbers — and an identity column burns a value on every
    // conflicting insert. So a returning email is looked up first, and a new one
    // is numbered max+1 under a transaction-scoped lock.
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${PARTICIPANT_LOCK})`;
      const [existing] = await tx`select number, token, email, is_test from participants where email = ${key}`;
      if (existing) return participantFromRow(existing);
      const [row] = await tx`
        insert into participants (number, token, email, is_test)
        select coalesce(max(number) + 1, 0), ${token}, ${key}, ${isTestEmail(key)} from participants
        returning number, token, email, is_test
      `;
      return participantFromRow(row);
    });
  }

  async participant(token: string): Promise<Participant | undefined> {
    const [row] = await this.sql`select number, token, email, is_test from participants where token = ${token}`;
    return row ? participantFromRow(row) : undefined;
  }

  async sessions(participantNumber: number): Promise<StudySession[]> {
    const rows = await this.sql`
      select * from study_sessions where participant_number = ${participantNumber} order by session_index
    `;
    return rows.map(sessionFromRow);
  }

  async session(id: string): Promise<StudySession | undefined> {
    const [row] = await this.sql`select * from study_sessions where id = ${id}`;
    return row ? sessionFromRow(row) : undefined;
  }

  async createSession(
    session: Omit<StudySession, "createdAt" | "completedAt">,
    calls: NewCall[],
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into study_sessions
          (id, participant_number, session_index, competitor, voice, ours_first, rehearsal, allocation)
        values (${session.id}, ${session.participantNumber}, ${session.index}, ${session.competitor},
                ${session.voice}, ${session.oursFirst}, ${session.rehearsal}, ${session.allocation})
      `;
      for (const call of calls) {
        await tx`
          insert into calls
            (token, session_id, position, system, cell_key, provider, voice_id, cell_source, card_id)
          values (${call.token}, ${call.sessionId}, ${call.position}, ${call.system}, ${call.cellKey},
                  ${call.provider}, ${call.voiceId}, ${call.cellSource}, ${call.cardId})
        `;
      }
    });
  }

  async calls(sessionId: string): Promise<StudyCall[]> {
    const rows = await this.sql`select * from calls where session_id = ${sessionId} order by position`;
    return rows.map(callFromRow);
  }

  async call(token: string): Promise<StudyCall | undefined> {
    const [row] = await this.sql`select * from calls where token = ${token}`;
    return row ? callFromRow(row) : undefined;
  }

  async recordCallEvent(token: string, event: CallEvent): Promise<void> {
    // Each event is one atomic update, so a server-side "spoke" and a page-side
    // "completed" landing together cannot overwrite each other.
    switch (event.type) {
      case "connected":
        await this.sql`update calls set attempts = attempts + 1, connected = true where token = ${token}`;
        return;
      case "spoke":
        await this.sql`update calls set spoke = true where token = ${token}`;
        return;
      case "dropped":
        await this.sql`update calls set drops = drops + 1 where token = ${token}`;
        return;
      case "skipped":
        await this.sql`update calls set skipped = true where token = ${token}`;
        return;
      case "completed":
        await this.sql`update calls set completed = true where token = ${token}`;
        return;
      case "fatal": {
        const message = `${event.code}: ${event.message}`.slice(0, 500);
        await this.sql`
          update calls set fatal_tts = fatal_tts or ${event.code === "tts"}, fatal_error = ${message}
          where token = ${token}
        `;
        return;
      }
    }
  }

  async linkRuntimeSession(runtimeId: string, callToken: string): Promise<void> {
    await this.sql`
      insert into runtime_sessions (runtime_id, call_token) values (${runtimeId}, ${callToken})
      on conflict (runtime_id) do nothing
    `;
  }

  async callForRuntime(runtimeId: string): Promise<string | undefined> {
    const [row] = await this.sql`select call_token from runtime_sessions where runtime_id = ${runtimeId}`;
    return row ? String(row.call_token) : undefined;
  }

  async recordTurn(runtimeId: string, callToken: string | null, t: TurnTimings): Promise<void> {
    await this.sql`
      insert into turns (
        runtime_id, call_token,
        whole_turn_ms, end_of_speech_ms, model_first_word_ms, voice_first_sound_ms, interrupted
      )
      values (
        ${runtimeId}, ${callToken},
        ${t.wholeTurnMs}, ${t.endOfSpeechMs}, ${t.modelFirstWordMs}, ${t.voiceFirstSoundMs}, ${t.interrupted}
      )
    `;
  }

  async recordUtterance(runtimeId: string, u: Utterance): Promise<void> {
    await this.sql`
      insert into utterances (runtime_id, call_token, role, text)
      values (${runtimeId}, ${u.callToken}, ${u.role}, ${u.text})
    `;
  }

  async saveResponse(r: StudyResponse): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into responses (
          session_id, preference, reasons, comment,
          call1_naturalness, call1_tone, call1_accuracy,
          call2_naturalness, call2_tone, call2_accuracy
        )
        values (
          ${r.sessionId}, ${r.preference}, ${tx.array([...r.reasons])}, ${r.comment},
          ${r.call1.naturalness}, ${r.call1.tone}, ${r.call1.accuracy},
          ${r.call2.naturalness}, ${r.call2.tone}, ${r.call2.accuracy}
        )
      `;
      await tx`update study_sessions set completed_at = now() where id = ${r.sessionId}`;
    });
  }

  async response(sessionId: string): Promise<StudyResponse | undefined> {
    const [row] = await this.sql`select * from responses where session_id = ${sessionId}`;
    return row ? responseFromRow(row) : undefined;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.sql`update study_sessions set completed_at = now() where id = ${sessionId} and completed_at is null`;
  }

  async matching(): Promise<MatchingSettings> {
    const [row] = await this.sql`select value, updated_at from study_settings where key = 'matching'`;
    if (!row) return DEFAULT_MATCHING;
    const value = row.value as { weights?: Partial<CompetitorWeights> };
    return { weights: { ...EQUAL_WEIGHTS, ...value.weights }, changedAt: row.updated_at as Date };
  }

  async saveMatching(weights: CompetitorWeights): Promise<MatchingSettings> {
    const [row] = await this.sql`
      insert into study_settings (key, value, updated_at)
      values ('matching', ${this.sql.json({ weights })}, now())
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
      returning updated_at
    `;
    return { weights: { ...weights }, changedAt: (row?.updated_at as Date) ?? new Date() };
  }

  async competitorCounts(since: Date | null, rehearsal: boolean): Promise<Record<Competitor, number>> {
    const rows = await this.sql`
      select competitor, count(*)::int as n from study_sessions
      where rehearsal = ${rehearsal} and (${since}::timestamptz is null or created_at >= ${since})
      group by competitor
    `;
    const counts = zeroCounts();
    for (const row of rows) {
      const competitor = row.competitor as Competitor;
      if (competitor in counts) counts[competitor] = Number(row.n);
    }
    return counts;
  }

  async dump(): Promise<StudyDump> {
    const [participants, sessions, calls, responses, turns, utterances] = await Promise.all([
      this.sql`select number, token, email, is_test from participants order by number`,
      this.sql`select * from study_sessions order by created_at`,
      this.sql`select * from calls order by created_at, position`,
      this.sql`select * from responses order by created_at`,
      this.sql`select * from turns order by created_at`,
      this.sql`select call_token, role, text from utterances order by id`,
    ]);
    return {
      participants: participants.map(participantFromRow),
      sessions: sessions.map(sessionFromRow),
      calls: calls.map(callFromRow),
      responses: responses.map(responseFromRow),
      turns: turns.map((row) => ({
        callToken: row.call_token === null ? null : String(row.call_token),
        wholeTurnMs: row.whole_turn_ms,
        endOfSpeechMs: row.end_of_speech_ms,
        modelFirstWordMs: row.model_first_word_ms,
        voiceFirstSoundMs: row.voice_first_sound_ms,
        interrupted: row.interrupted,
      })),
      utterances: utterances.map((row) => ({
        callToken: String(row.call_token),
        role: row.role as Utterance["role"],
        text: String(row.text),
      })),
    };
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

/** The tables, created if absent. The old single-call tables are left alone. */
async function ensureSchema(sql: Sql): Promise<void> {
  await sql`
    create table if not exists participants (
      number     integer primary key,
      token      text not null unique,
      email      text not null unique,
      is_test    boolean not null,
      created_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists study_sessions (
      id                 text primary key,
      participant_number integer not null references participants (number),
      session_index      integer not null,
      competitor         text not null,
      voice              text not null,
      ours_first         boolean not null,
      rehearsal          boolean not null,
      created_at         timestamptz not null default now(),
      completed_at       timestamptz,
      unique (participant_number, session_index)
    )
  `;
  // Added after the first deploy: a database created before it gains the column,
  // with every existing session marked balanced — which is what they were.
  await sql`
    alter table study_sessions add column if not exists allocation text not null default 'balanced'
  `;
  await sql`
    create table if not exists study_settings (
      key        text primary key,
      value      jsonb not null,
      updated_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists calls (
      token       text primary key,
      session_id  text not null references study_sessions (id),
      position    integer not null,
      system      text not null,
      cell_key    text not null,
      provider    text not null,
      voice_id    text,
      cell_source text not null,
      card_id     text not null,
      attempts    integer not null default 0,
      connected   boolean not null default false,
      spoke       boolean not null default false,
      drops       integer not null default 0,
      skipped     boolean not null default false,
      completed   boolean not null default false,
      fatal_tts   boolean not null default false,
      fatal_error text,
      created_at  timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists runtime_sessions (
      runtime_id text primary key,
      call_token text not null references calls (token),
      created_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists responses (
      session_id        text primary key references study_sessions (id),
      preference        integer not null,
      reasons           text[] not null,
      comment           text,
      call1_naturalness integer not null,
      call1_tone        integer not null,
      call1_accuracy    integer not null,
      call2_naturalness integer not null,
      call2_tone        integer not null,
      call2_accuracy    integer not null,
      created_at        timestamptz not null default now()
    )
  `;
  // `turns` existed in the single-call version keyed by `call_id`; this one is
  // keyed by the runtime session and the call token, so it gets its own name.
  await sql`
    create table if not exists turns (
      id                   bigint generated always as identity primary key,
      runtime_id           text not null,
      call_token           text,
      whole_turn_ms        integer,
      end_of_speech_ms     integer,
      model_first_word_ms  integer,
      voice_first_sound_ms integer,
      interrupted          boolean not null,
      created_at           timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists utterances (
      id         bigint generated always as identity primary key,
      runtime_id text not null,
      call_token text not null,
      role       text not null,
      text       text not null,
      created_at timestamptz not null default now()
    )
  `;
}

function zeroCounts(): Record<Competitor, number> {
  return Object.fromEntries(COMPETITORS.map((c) => [c, 0])) as Record<Competitor, number>;
}

type Row = Record<string, unknown>;

function participantFromRow(row: Row | undefined): Participant {
  if (!row) throw new Error("expected a participant row");
  return { number: Number(row.number), token: String(row.token), email: String(row.email), isTest: Boolean(row.is_test) };
}

function sessionFromRow(row: Row): StudySession {
  return {
    id: String(row.id),
    participantNumber: Number(row.participant_number),
    index: Number(row.session_index),
    competitor: row.competitor as Competitor,
    voice: row.voice as VoiceName,
    oursFirst: Boolean(row.ours_first),
    rehearsal: Boolean(row.rehearsal),
    allocation: row.allocation === "weighted" ? "weighted" : "balanced",
    createdAt: row.created_at as Date,
    completedAt: (row.completed_at as Date | null) ?? null,
  };
}

function callFromRow(row: Row): StudyCall {
  return {
    token: String(row.token),
    sessionId: String(row.session_id),
    position: Number(row.position) as 1 | 2,
    system: row.system as System,
    cellKey: String(row.cell_key),
    provider: String(row.provider),
    voiceId: row.voice_id === null ? null : String(row.voice_id),
    cellSource: row.cell_source as StudyCall["cellSource"],
    cardId: String(row.card_id),
    attempts: Number(row.attempts),
    connected: Boolean(row.connected),
    spoke: Boolean(row.spoke),
    drops: Number(row.drops),
    skipped: Boolean(row.skipped),
    completed: Boolean(row.completed),
    fatalTts: Boolean(row.fatal_tts),
    fatalError: row.fatal_error === null ? null : String(row.fatal_error),
  };
}

function responseFromRow(row: Row): StudyResponse {
  return {
    sessionId: String(row.session_id),
    preference: Number(row.preference),
    reasons: (row.reasons as string[]) ?? [],
    comment: row.comment === null ? null : String(row.comment),
    call1: { naturalness: Number(row.call1_naturalness), tone: Number(row.call1_tone), accuracy: Number(row.call1_accuracy) },
    call2: { naturalness: Number(row.call2_naturalness), tone: Number(row.call2_tone), accuracy: Number(row.call2_accuracy) },
  };
}
