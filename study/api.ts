/**
 * The study's HTTP API — what the page calls between calls.
 *
 * | route | does |
 * | --- | --- |
 * | `POST /api/signin` `{ email }` | finds or creates the participant; returns their token and progress |
 * | `POST /api/progress` `{ participant }` | their progress, for a returning page; hands nothing out |
 * | `POST /api/sessions` `{ participant }` | resumes their unfinished session, or hands out the next one |
 * | `POST /api/calls/event` `{ call, type }` | the page reports a call `completed`, `skipped` or `dropped` |
 * | `POST /api/responses` `{ participant, session, … }` | saves the questionnaire and closes the session |
 * | `POST /api/sessions/close` `{ participant, session }` | closes a session with a skipped call, unanswered |
 *
 * ## What the page is never told
 *
 * A session comes back as two opaque call tokens and two persona cards. The
 * system, the voice, the order and the competitor stay in the store; the socket
 * presents the token and the server looks up which engine answers it. So nothing
 * in the browser — DOM, network tab or bundle — says which call was ours.
 *
 * ## No sign-in check (accepted)
 *
 * The email is an identity, not a credential: there is no verification and no
 * rate limit, as the protocol accepts for an internal study. The participant
 * token the page holds is a random UUID, so one person cannot act as another by
 * guessing a number.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveCell, type GridOptions } from "../voices.ts";
import { cardById, cardView, type CardView } from "./cards.ts";
import {
  chooseCompetitor,
  type Competitor,
  COMPETITORS,
  type CompetitorWeights,
  isBalanced,
  SESSIONS_PER_BLOCK,
  type SessionPlan,
  sessionFor,
  weightedSessionFor,
} from "./design.ts";
import type { Participant, StudySession, StudyStore } from "./store.ts";

/** A refusal the server turns into that HTTP status with `{ error }`. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The page's view of a participant's progress. */
export interface ProgressView {
  participant: string;
  /** Sessions finished (answered or closed). */
  completed: number;
  total: number;
  /** Whether another session can be started (or one is waiting to resume). */
  canContinue: boolean;
  /** A session was handed out and not finished; starting resumes it. */
  open: boolean;
}

/** The page's view of one session: tokens and cards, nothing else. */
export interface SessionView {
  session: string;
  index: number;
  total: number;
  calls: { token: string; position: 1 | 2; card: CardView; done: boolean; skipped: boolean }[];
}

export const REASONS = ["human", "tone", "accuracy", "speed", "other"] as const;

const rating = z.number().int().min(1).max(5);
const ratings = z.object({ naturalness: rating, tone: rating, accuracy: rating });

export const SignInBody = z.object({ email: z.string().trim().email().max(320) });
export const StartBody = z.object({ participant: z.string().uuid() });
export const CallEventBody = z.object({
  call: z.string().uuid(),
  type: z.enum(["completed", "skipped", "dropped"]),
});
export const ResponseBody = z.object({
  participant: z.string().uuid(),
  session: z.string().uuid(),
  preference: z.number().int().min(-2).max(2),
  reasons: z.array(z.enum(REASONS)).max(2),
  comment: z.string().trim().max(2000).optional(),
  call1: ratings,
  call2: ratings,
});
export const CloseBody = z.object({ participant: z.string().uuid(), session: z.string().uuid() });

const weight = z.number().min(0).max(100);
export const MatchingBody = z
  .object({ weights: z.object({ cartesia: weight, elevenlabs: weight, inworld: weight }) })
  .refine((body) => COMPETITORS.some((c) => body.weights[c] > 0), {
    message: "at least one competitor needs a weight above 0",
  });

/** What the admin page shows about matching. */
export interface MatchingView {
  weights: CompetitorWeights;
  /** Equal weights: the protocol's balanced block is in use. */
  balanced: boolean;
  changedAt: string | null;
  /** The share of new sessions each competitor is steered toward. */
  targetShare: Record<Competitor, number>;
  /** Study (non-rehearsal) sessions handed out per competitor since the last change. */
  sinceChange: Record<Competitor, number>;
}

export interface StudyApiOptions {
  store: StudyStore;
  grid: GridOptions;
  studySeed: string;
  newId?: () => string;
}

/** Parse a body against a schema, or a 400 naming what was wrong. */
export function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

export class StudyApi {
  private readonly store: StudyStore;
  private readonly grid: GridOptions;
  private readonly studySeed: string;
  private readonly newId: () => string;
  /** A session handed out by a server not running the real grid is never data. */
  private readonly rehearsal: boolean;

  constructor(options: StudyApiOptions) {
    this.store = options.store;
    this.grid = options.grid;
    this.studySeed = options.studySeed;
    this.newId = options.newId ?? randomUUID;
    this.rehearsal = Boolean(options.grid.oursStandIn) || Boolean(options.grid.allowMissing);
  }

  async signIn(raw: unknown): Promise<ProgressView> {
    const { email } = parseBody(SignInBody, raw);
    const participant = await this.store.signIn(email, this.newId());
    return this.progress(participant);
  }

  async progressFor(raw: unknown): Promise<ProgressView> {
    return this.progress(await this.participantFor(parseBody(StartBody, raw).participant));
  }

  async startSession(raw: unknown): Promise<SessionView> {
    const participant = await this.participantFor(parseBody(StartBody, raw).participant);
    const sessions = await this.store.sessions(participant.number);
    const open = sessions.find((s) => s.completedAt === null);
    if (open) return this.sessionView(open);
    if (sessions.length >= SESSIONS_PER_BLOCK) {
      throw new ApiError(409, `all ${SESSIONS_PER_BLOCK} sessions are done`);
    }

    const { plan, allocation } = await this.nextPlan(participant.number, sessions);
    const id = this.newId();
    const calls = plan.calls.map((call) => {
      const cell = resolveCell(call.system, plan.voice, this.grid);
      return {
        token: this.newId(),
        sessionId: id,
        position: call.position,
        system: call.system,
        cellKey: cell.key,
        provider: cell.provider,
        voiceId: cell.voiceId ?? null,
        cellSource: cell.source,
        cardId: call.cardId,
      };
    });
    const session = {
      id,
      participantNumber: participant.number,
      index: plan.index,
      competitor: plan.competitor,
      voice: plan.voice,
      oursFirst: plan.oursFirst,
      rehearsal: this.rehearsal,
      allocation,
    };
    try {
      await this.store.createSession(session, calls);
    } catch (error) {
      // Two tabs raced to start the same session: the loser resumes the winner's.
      const winner = (await this.store.sessions(participant.number)).find((s) => s.index === plan.index);
      if (winner) return this.sessionView(winner);
      throw error;
    }
    const created = await this.store.session(id);
    if (!created) throw new Error(`session ${id} vanished after create`);
    return this.sessionView(created);
  }

  /**
   * The plan for a participant's next session. Equal weights: their balanced
   * block, exactly as the protocol lays it out. Unequal: the competitor furthest
   * behind its target share since the weights changed, with the voice and cards
   * the block would have used and the per-competitor order kept counterbalanced.
   */
  private async nextPlan(
    participant: number,
    sessions: StudySession[],
  ): Promise<{ plan: SessionPlan; allocation: "balanced" | "weighted" }> {
    const index = sessions.length + 1;
    const { weights, changedAt } = await this.store.matching();
    if (isBalanced(weights)) {
      return { plan: sessionFor(participant, index, this.studySeed), allocation: "balanced" };
    }
    const handedOut = await this.store.competitorCounts(changedAt, this.rehearsal);
    const met = Object.fromEntries(
      COMPETITORS.map((c) => [c, sessions.filter((s) => s.competitor === c).length]),
    ) as Record<Competitor, number>;
    const competitor = chooseCompetitor(weights, handedOut, met);
    return {
      plan: weightedSessionFor(participant, index, competitor, met[competitor], this.studySeed),
      allocation: "weighted",
    };
  }

  /** The matching weights and how they are landing — for the admin page. */
  async matching(): Promise<MatchingView> {
    const { weights, changedAt } = await this.store.matching();
    const total = COMPETITORS.reduce((sum, c) => sum + weights[c], 0);
    return {
      weights,
      balanced: isBalanced(weights),
      changedAt: changedAt?.toISOString() ?? null,
      targetShare: Object.fromEntries(
        COMPETITORS.map((c) => [c, total === 0 ? 0 : Math.round((weights[c] / total) * 1000) / 1000]),
      ) as Record<Competitor, number>,
      sinceChange: await this.store.competitorCounts(changedAt, false),
    };
  }

  async setMatching(raw: unknown): Promise<MatchingView> {
    const { weights } = parseBody(MatchingBody, raw);
    await this.store.saveMatching(weights);
    return this.matching();
  }

  async callEvent(raw: unknown): Promise<{ ok: true }> {
    const { call, type } = parseBody(CallEventBody, raw);
    if (!(await this.store.call(call))) throw new ApiError(404, "no such call");
    await this.store.recordCallEvent(call, { type });
    return { ok: true };
  }

  async submitResponse(raw: unknown): Promise<ProgressView> {
    const body = parseBody(ResponseBody, raw);
    const { participant, session } = await this.ownedOpenSession(body.participant, body.session);
    await this.store.saveResponse({
      sessionId: session.id,
      preference: body.preference,
      reasons: body.reasons,
      comment: body.comment ? body.comment : null,
      call1: body.call1,
      call2: body.call2,
    });
    return this.progress(participant);
  }

  async closeSession(raw: unknown): Promise<ProgressView> {
    const body = parseBody(CloseBody, raw);
    const { participant, session } = await this.ownedOpenSession(body.participant, body.session);
    await this.store.closeSession(session.id);
    return this.progress(participant);
  }

  private async participantFor(token: string): Promise<Participant> {
    const participant = await this.store.participant(token);
    if (!participant) throw new ApiError(401, "unknown participant; sign in again");
    return participant;
  }

  private async ownedOpenSession(token: string, sessionId: string) {
    const participant = await this.participantFor(token);
    const session = await this.store.session(sessionId);
    if (!session || session.participantNumber !== participant.number) {
      throw new ApiError(404, "no such session");
    }
    if (session.completedAt !== null) throw new ApiError(409, "this session is already finished");
    return { participant, session };
  }

  private async progress(participant: Participant): Promise<ProgressView> {
    const sessions = await this.store.sessions(participant.number);
    const completed = sessions.filter((s) => s.completedAt !== null).length;
    return {
      participant: participant.token,
      completed,
      total: SESSIONS_PER_BLOCK,
      canContinue: completed < SESSIONS_PER_BLOCK,
      open: sessions.some((s) => s.completedAt === null),
    };
  }

  private async sessionView(session: StudySession): Promise<SessionView> {
    const calls = await this.store.calls(session.id);
    return {
      session: session.id,
      index: session.index,
      total: SESSIONS_PER_BLOCK,
      calls: calls.map((call) => {
        const card = cardById(call.cardId);
        if (!card) throw new Error(`call ${call.token} names unknown card ${call.cardId}`);
        return {
          token: call.token,
          position: call.position,
          card: cardView(card),
          done: call.completed || call.skipped,
          skipped: call.skipped,
        };
      }),
    };
  }
}
