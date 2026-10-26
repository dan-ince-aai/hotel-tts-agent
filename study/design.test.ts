import { describe, expect, test } from "vitest";
import { CARDS, cardById, cardView, formatAddress, formatNight } from "./cards.ts";
import {
  chooseCompetitor,
  COMPETITORS,
  isBalanced,
  oursFirstFor,
  weightedSessionFor,
  type Competitor,
  scheduleFor,
  SESSIONS_PER_BLOCK,
  type SessionPlan,
  sessionFor,
  VOICE_NAMES,
} from "./design.ts";

describe("one participant's block", () => {
  const block = scheduleFor(0);

  test("is six sessions, each pairing ours with one competitor in the same voice", () => {
    expect(block).toHaveLength(SESSIONS_PER_BLOCK);
    for (const session of block) {
      const systems = session.calls.map((call) => call.system).sort();
      expect(systems).toEqual(["ours", session.competitor].sort());
      expect(session.calls.map((call) => call.position)).toEqual([1, 2]);
    }
  });

  test("meets each competitor once per half, with the call order reversed the second time", () => {
    for (let participant = 0; participant < 24; participant++) {
      const sessions = scheduleFor(participant);
      const firstHalf = sessions.slice(0, 3);
      const secondHalf = sessions.slice(3);
      expect(firstHalf.map((s) => s.competitor).sort()).toEqual([...COMPETITORS].sort());
      for (let i = 0; i < 3; i++) {
        const a = firstHalf[i];
        const b = secondHalf[i];
        expect(b?.competitor).toBe(a?.competitor);
        expect(b?.oursFirst).toBe(!a?.oursFirst);
      }
    }
  });

  test("puts ours first in exactly half of each competitor's sessions", () => {
    for (const competitor of COMPETITORS) {
      const theirs = block.filter((s) => s.competitor === competitor);
      expect(theirs.filter((s) => s.oursFirst)).toHaveLength(1);
    }
  });

  test("the call order matches oursFirst", () => {
    for (const session of block) {
      expect(session.calls[0].system === "ours").toBe(session.oursFirst);
    }
  });

  test("hears a different voice in every session, all from the study's voices", () => {
    const voices = block.map((s) => s.voice);
    expect(new Set(voices).size).toBe(Math.min(SESSIONS_PER_BLOCK, VOICE_NAMES.length));
    for (const voice of voices) expect(VOICE_NAMES).toContain(voice);
  });

  test("never repeats a persona card across the twelve calls", () => {
    const cards = block.flatMap((s) => s.calls.map((call) => call.cardId));
    expect(cards).toHaveLength(12);
    expect(new Set(cards).size).toBe(12);
    for (const id of cards) expect(cardById(id)).toBeDefined();
  });

  test("is reproducible from the participant number and seed, and differs by seed", () => {
    expect(scheduleFor(7)).toEqual(scheduleFor(7));
    expect(scheduleFor(7, "a")).not.toEqual(scheduleFor(7, "b"));
    expect(sessionFor(7, 3)).toEqual(scheduleFor(7)[2]);
  });

  test("refuses a bad participant number or session index", () => {
    expect(() => scheduleFor(-1)).toThrow();
    expect(() => scheduleFor(1.5)).toThrow();
    expect(() => sessionFor(0, 0)).toThrow();
    expect(() => sessionFor(0, 7)).toThrow();
  });
});

/**
 * The 300-person balance simulation. People stop early, and the study only
 * holds up if the factors stay balanced over the sessions actually RUN, so this
 * truncates each block at a random length — both evenly spread over 1–6 and
 * skewed to one or two sessions, the two participation patterns the protocol's
 * precision estimate considers — and checks the balance survives.
 */
describe("balance over 300 participants who stop early", () => {
  /** Deterministic stop points, so the test never flakes. */
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  const patterns = {
    even: (r: number) => 1 + Math.floor(r * 6),
    // Mostly one or two sessions, a tail to six.
    skewed: (r: number) => (r < 0.4 ? 1 : r < 0.75 ? 2 : r < 0.85 ? 3 : r < 0.92 ? 4 : r < 0.96 ? 5 : 6),
  };

  for (const [name, stopAt] of Object.entries(patterns)) {
    test(`${name} participation keeps order, competitor and voice balanced`, () => {
      const random = lcg(name === "even" ? 1 : 2);
      const run: SessionPlan[] = [];
      for (let participant = 0; participant < 300; participant++) {
        run.push(...scheduleFor(participant).slice(0, stopAt(random())));
      }

      const byCompetitor = (c: Competitor) => run.filter((s) => s.competitor === c);
      for (const competitor of COMPETITORS) {
        const theirs = byCompetitor(competitor);
        // Each competitor gets about a third of the sessions…
        expect(theirs.length / run.length).toBeGreaterThan(0.3);
        expect(theirs.length / run.length).toBeLessThan(0.37);
        // …with ours first close to half the time.
        const oursFirstShare = theirs.filter((s) => s.oursFirst).length / theirs.length;
        expect(oursFirstShare).toBeGreaterThan(0.45);
        expect(oursFirstShare).toBeLessThan(0.55);
        // And every voice is heard against every competitor, roughly evenly.
        const even = 1 / VOICE_NAMES.length;
        for (const voice of VOICE_NAMES) {
          const share = theirs.filter((s) => s.voice === voice).length / theirs.length;
          expect(share, `${competitor}/${voice}`).toBeGreaterThan(even * 0.5);
          expect(share, `${competitor}/${voice}`).toBeLessThan(even * 1.6);
        }
      }

      // Ours first overall is close to half, and the first session especially —
      // the one every participant does.
      const firsts = run.filter((s) => s.index === 1);
      const firstShare = firsts.filter((s) => s.oursFirst).length / firsts.length;
      expect(firstShare).toBeGreaterThan(0.45);
      expect(firstShare).toBeLessThan(0.55);
    });
  }
});

describe("the persona cards", () => {
  test("are twelve, with unique ids, names and addresses", () => {
    expect(CARDS).toHaveLength(12);
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(12);
    expect(new Set(CARDS.map((c) => c.last)).size).toBe(12);
    expect(new Set(CARDS.map(formatAddress)).size).toBe(12);
  });

  test("every address has a number, street type, unit, state code and ZIP", () => {
    for (const card of CARDS) {
      const a = card.address;
      expect(a.number).toMatch(/^\d+$/);
      expect(a.streetType).toMatch(/^[A-Z][a-z]+$/);
      expect(a.unit).toMatch(/^(Apt|Unit|Ste) \w+$/);
      expect(a.state).toMatch(/^[A-Z]{2}$/);
      expect(a.zip).toMatch(/^\d{5}$/);
    }
  });

  test("shows the protocol's example card exactly", () => {
    const card = cardById("c01");
    expect(card && cardView(card)).toEqual({
      name: "Jennifer Thompson",
      night: "Sunday, March 21st",
      address: "1847 Maple Ridge Dr, Apt 4B, Columbus, OH 43215",
    });
  });

  test("formats ordinals and derives the weekday", () => {
    expect(formatNight("2027-04-02")).toBe("Friday, April 2nd");
    expect(formatNight("2027-04-03")).toBe("Saturday, April 3rd");
    expect(formatNight("2027-04-11")).toBe("Sunday, April 11th");
    expect(formatNight("2027-04-22")).toBe("Thursday, April 22nd");
  });
});

describe("weighted matching", () => {
  const zero = { cartesia: 0, elevenlabs: 0, inworld: 0 };

  test("equal positive weights are the balanced block; anything else is not", () => {
    expect(isBalanced({ cartesia: 1, elevenlabs: 1, inworld: 1 })).toBe(true);
    expect(isBalanced({ cartesia: 3, elevenlabs: 3, inworld: 3 })).toBe(true);
    expect(isBalanced({ cartesia: 2, elevenlabs: 1, inworld: 1 })).toBe(false);
    expect(isBalanced({ cartesia: 0, elevenlabs: 0, inworld: 0 })).toBe(false);
  });

  test("hands out sessions in the target shares, exactly, at any size", () => {
    const weights = { cartesia: 1, elevenlabs: 1, inworld: 2 };
    const handed = { ...zero };
    for (let i = 0; i < 400; i++) handed[chooseCompetitor(weights, handed, zero)]++;
    expect(handed).toEqual({ cartesia: 100, elevenlabs: 100, inworld: 200 });
  });

  test("a weight of 0 is never chosen", () => {
    const weights = { cartesia: 0, elevenlabs: 1, inworld: 1 };
    const handed = { ...zero };
    for (let i = 0; i < 50; i++) handed[chooseCompetitor(weights, handed, zero)]++;
    expect(handed.cartesia).toBe(0);
    expect(() => chooseCompetitor(zero, zero, zero)).toThrow();
  });

  test("on a tie, the competitor this participant has met least goes first", () => {
    const weights = { cartesia: 1, elevenlabs: 1, inworld: 1 };
    expect(chooseCompetitor(weights, zero, { cartesia: 2, elevenlabs: 0, inworld: 1 })).toBe("elevenlabs");
  });

  test("keeps call order counterbalanced per competitor however the weights skew", () => {
    for (const competitor of COMPETITORS) {
      const firstMeetings = Array.from({ length: 100 }, (_, n) => oursFirstFor(n, competitor, 0));
      expect(firstMeetings.filter(Boolean)).toHaveLength(50);
      // And it alternates for one person meeting the same competitor again.
      expect(oursFirstFor(7, competitor, 1)).toBe(!oursFirstFor(7, competitor, 0));
    }
  });

  test("a re-paired session keeps the block's voice and cards, with ours on the right call", () => {
    const base = sessionFor(4, 2);
    const paired = weightedSessionFor(4, 2, "inworld", 0);
    expect(paired.voice).toBe(base.voice);
    expect(paired.calls.map((c) => c.cardId)).toEqual(base.calls.map((c) => c.cardId));
    expect(paired.competitor).toBe("inworld");
    expect(paired.calls[0].system === "ours").toBe(paired.oursFirst);
    expect(paired.calls.map((c) => c.system).sort()).toEqual(["inworld", "ours"]);
  });
});
