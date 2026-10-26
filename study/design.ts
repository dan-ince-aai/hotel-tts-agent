/**
 * The session schedule: which competitor, which voice, which call order and
 * which persona cards each of a participant's sessions uses.
 *
 * ## The design (see the protocol, "One session, two calls")
 *
 * A session is two calls in the SAME cloned voice: our model and one competitor.
 * Six sessions make one balanced block per participant:
 *
 * - Sessions 1–3 meet each competitor once; sessions 4–6 meet them again, in the
 *   same competitor order, with the call order reversed. So every competitor is
 *   heard once with ours first and once with ours second.
 * - Ours-first alternates session to session, so a participant who stops after
 *   one or two sessions has still not heard ours in the same slot twice.
 * - The voice changes every session: the enabled voices, in a per-person shuffled order
 *   (repeating only if fewer than six are enabled).
 * - The twelve persona cards are dealt two per session; none repeats.
 *
 * ## Balanced across participants, not just within one
 *
 * Most people will not finish all six sessions, so the factors the analysis
 * leans on hardest — which competitor comes when, and whether ours goes first —
 * are assigned DETERMINISTICALLY from the participant's number so they balance
 * over every run of twelve sign-ups: the competitor order cycles through all six
 * permutations, and the ours-first phase flips every six participants. The voice
 * order and the card deal, which only need to be spread out, are shuffled per
 * person from a seeded generator, so a participant's schedule is reproducible
 * from (study seed, participant number) alone and never has to be stored.
 *
 * The page never sees any of this: the server keeps the plan and hands the
 * browser an opaque token per call (`server.ts`).
 *
 * ## Unequal weights
 *
 * The admin can weight the competitors (see {@link chooseCompetitor}) — to put
 * more sessions on the comparison that is hardest to call, or to pause a
 * provider. Then the competitor is chosen per session to hit the target shares,
 * and the per-person block ("each competitor once per half") no longer holds;
 * voice rotation, the card deal and the per-competitor order balance still do.
 */
import { CARDS } from "./cards.ts";
import voiceIds from "./voice-ids.json" with { type: "json" };

export const COMPETITORS = ["cartesia", "elevenlabs", "inworld"] as const;
export type Competitor = (typeof COMPETITORS)[number];

/** A system under test: our model, or one of the competitors. */
export type System = "ours" | Competitor;
export const SYSTEMS: readonly System[] = ["ours", ...COMPETITORS];

/**
 * The voices under study, by slug (`aai-audrey`…), in `study/voice-ids.json` order. Each is
 * one reference recording, spoken natively by ours and cloned into every competitor.
 */
export const VOICE_NAMES: readonly string[] = voiceIds.voices.map((voice) => voice.slug);
export type VoiceName = string;

/** Sessions in one balanced block — the most a participant may do. */
export const SESSIONS_PER_BLOCK = 6;

export interface CallPlan {
  /** 1 or 2 — the call's position in the session. */
  readonly position: 1 | 2;
  readonly system: System;
  /** Persona card id (`study/cards.ts`). */
  readonly cardId: string;
}

export interface SessionPlan {
  /** 1…6 — this session's place in the participant's block. */
  readonly index: number;
  readonly competitor: Competitor;
  readonly voice: VoiceName;
  readonly oursFirst: boolean;
  readonly calls: readonly [CallPlan, CallPlan];
}

/** All orderings of a list — six for the competitors, twenty-four for voices. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([item, ...tail]);
  });
  return out;
}

const COMPETITOR_ORDERS = permutations(COMPETITORS);

/**
 * mulberry32 — a tiny, well-mixed 32-bit PRNG. Seeded so a schedule is a pure
 * function of (study seed, participant number) and replays identically.
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, for turning a seed phrase into a PRNG seed. */
function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * The full six-session block for participant number `participant` (0-based, in
 * sign-up order). A participant does sessions from the front of this list; the
 * ones they never reach are simply never run.
 */
export function scheduleFor(
  participant: number,
  studySeed = "harborlight",
  voices: readonly VoiceName[] = VOICE_NAMES,
): SessionPlan[] {
  if (!Number.isInteger(participant) || participant < 0) {
    throw new Error(`participant number must be a non-negative integer, got ${participant}`);
  }
  const competitorOrder = COMPETITOR_ORDERS[participant % COMPETITOR_ORDERS.length] as Competitor[];
  // Flips every six participants, so over twelve sign-ups each competitor sits in
  // each session slot with ours first exactly as often as with ours second.
  const oursFirstPhase = Math.floor(participant / COMPETITOR_ORDERS.length) % 2 === 0;

  const random = seededRandom(hashSeed(`${studySeed}:${participant}`));
  // Shuffle ALL the voices, then keep the enabled ones in that order: the random draws are
  // the same whatever is enabled, so switching a voice off never reshuffles the card deal.
  const enabled = new Set(voices);
  const voiceOrder = shuffled(VOICE_NAMES, random).filter((voice) => enabled.has(voice));
  if (voiceOrder.length === 0) throw new Error("no voices are enabled");
  const deck = shuffled(
    CARDS.map((card) => card.id),
    random,
  );

  const sessions: SessionPlan[] = [];
  for (let k = 0; k < SESSIONS_PER_BLOCK; k++) {
    const competitor = competitorOrder[k % competitorOrder.length] as Competitor;
    // Alternates every session; because the block is an odd three long, the
    // second block lands each competitor on the opposite order from the first.
    const oursFirst = (k % 2 === 0) === oursFirstPhase;
    const [first, second]: System[] = oursFirst ? ["ours", competitor] : [competitor, "ours"];
    sessions.push({
      index: k + 1,
      competitor,
      voice: voiceOrder[k % voiceOrder.length] as VoiceName,
      oursFirst,
      calls: [
        { position: 1, system: first as System, cardId: deck[2 * k] as string },
        { position: 2, system: second as System, cardId: deck[2 * k + 1] as string },
      ],
    });
  }
  return sessions;
}

/** One session of a participant's block, by 1-based index. */
export function sessionFor(
  participant: number,
  index: number,
  studySeed?: string,
  voices?: readonly VoiceName[],
): SessionPlan {
  const plan = scheduleFor(participant, studySeed, voices)[index - 1];
  if (plan === undefined) {
    throw new Error(`session index must be 1…${SESSIONS_PER_BLOCK}, got ${index}`);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Weighted matching — when the admin wants more of one comparison.
// ---------------------------------------------------------------------------

/**
 * How often each competitor is paired with ours, as relative weights. Ours is
 * in every session regardless; these only decide WHICH competitor it faces. A
 * weight of 0 takes a competitor out of rotation (a provider that is down).
 */
export type CompetitorWeights = Record<Competitor, number>;

export const EQUAL_WEIGHTS: CompetitorWeights = { cartesia: 1, elevenlabs: 1, inworld: 1 };

/** Equal, positive weights: the protocol's balanced block applies unchanged. */
export function isBalanced(weights: CompetitorWeights): boolean {
  const values = COMPETITORS.map((c) => weights[c]);
  return values.every((w) => w > 0 && w === values[0]);
}

/**
 * The competitor for the next session under unequal weights: the one furthest
 * BEHIND its target share of the sessions handed out since the weights were
 * set. Deterministic rather than a weighted coin, so the shares land on target
 * at any sample size instead of wandering around it. Ties go to the competitor
 * this participant has met least, so one person still hears a spread.
 */
export function chooseCompetitor(
  weights: CompetitorWeights,
  handedOut: Record<Competitor, number>,
  metByParticipant: Record<Competitor, number>,
): Competitor {
  const live = COMPETITORS.filter((c) => weights[c] > 0);
  if (live.length === 0) throw new Error("every competitor has weight 0; nothing to pair ours with");
  const totalWeight = live.reduce((sum, c) => sum + weights[c], 0);
  // +1: the session being handed out now is part of the total it should share.
  const total = live.reduce((sum, c) => sum + handedOut[c], 0) + 1;
  const deficit = (c: Competitor) => (weights[c] / totalWeight) * total - handedOut[c];
  return [...live].sort(
    (a, b) =>
      deficit(b) - deficit(a) ||
      metByParticipant[a] - metByParticipant[b] ||
      COMPETITORS.indexOf(a) - COMPETITORS.indexOf(b),
  )[0] as Competitor;
}

/**
 * Whether ours goes first when this participant meets `competitor` for the
 * `meeting`-th time (0-based). Alternates per competitor within a person, and
 * the first meeting's order alternates across participant numbers — so the
 * order stays counterbalanced per competitor however the weights skew who is met.
 */
export function oursFirstFor(participant: number, competitor: Competitor, meeting: number): boolean {
  return (participant + COMPETITORS.indexOf(competitor) + meeting) % 2 === 0;
}

/**
 * The participant's session `index`, re-paired with `competitor`: the same voice
 * and persona cards their balanced schedule gives that session, so only the
 * matching changes.
 */
export function weightedSessionFor(
  participant: number,
  index: number,
  competitor: Competitor,
  meeting: number,
  studySeed?: string,
  voices?: readonly VoiceName[],
): SessionPlan {
  const base = sessionFor(participant, index, studySeed, voices);
  const oursFirst = oursFirstFor(participant, competitor, meeting);
  const [first, second]: System[] = oursFirst ? ["ours", competitor] : [competitor, "ours"];
  return {
    ...base,
    competitor,
    oursFirst,
    calls: [
      { ...base.calls[0], system: first as System },
      { ...base.calls[1], system: second as System },
    ],
  };
}
