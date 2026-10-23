import { describe, expect, test } from "vitest";
import { CARDS, cardById, cardView, formatAddress, formatNight } from "./cards.ts";
import {
  COMPETITORS,
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

  test("rotates the voice between consecutive sessions and uses all four", () => {
    const voices = block.map((s) => s.voice);
    for (let i = 1; i < voices.length; i++) expect(voices[i]).not.toBe(voices[i - 1]);
    expect(new Set(voices)).toEqual(new Set(VOICE_NAMES));
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
        for (const voice of VOICE_NAMES) {
          const share = theirs.filter((s) => s.voice === voice).length / theirs.length;
          expect(share, `${competitor}/${voice}`).toBeGreaterThan(0.17);
          expect(share, `${competitor}/${voice}`).toBeLessThan(0.33);
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
