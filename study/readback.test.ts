import { describe, expect, test } from "vitest";
import { cardById, type PersonaCard } from "./cards.ts";
import { checkReadback } from "./readback.ts";

const card = cardById("c01") as PersonaCard; // Jennifer Thompson, March 21st, 1847 Maple Ridge Dr, Apt 4B, Columbus, OH 43215

const GOOD = [
  "Hello, thanks for calling the Harborlight Hotel. Are you ready to book a room with us?",
  "Wonderful - may I have your full name, and could you spell your last name for me?",
  "Thank you, Jennifer Thompson, that's T-H-O-M-P-S-O-N. Which night would you like?",
  "Sunday, March 21st - lovely. What's your full street address?",
  "That's 1847 Maple Ridge Dr, Apt 4B, Columbus, OH 43215 - is that right?",
];

describe("checkReadback", () => {
  test("a clean call passes on all three", () => {
    expect(checkReadback(GOOD, card)).toEqual({ name: true, night: true, address: true, ok: true });
  });

  test("accepts other spelling separators and date forms", () => {
    const variant = [
      "Jennifer Thompson - T, H, O, M, P, S, O, N.",
      "The 21st of March, got it.",
      "1847 Maple Ridge Drive, apartment 4B, Columbus, Ohio, 43215.",
    ];
    expect(checkReadback(variant, card).ok).toBe(true);
    expect(checkReadback(["Jennifer Thompson, T H O M P S O N", "3/21", "x"], card).night).toBe(true);
  });

  test("a misspelled read-back fails the name", () => {
    const wrong = GOOD.map((line) => line.replace("T-H-O-M-P-S-O-N", "T-H-O-M-S-O-N"));
    expect(checkReadback(wrong, card)).toMatchObject({ name: false, ok: false });
  });

  test("the wrong day fails the night, and is not fooled by a matching day elsewhere", () => {
    const wrong = GOOD.map((line) => line.replace("March 21st", "March 12th"));
    expect(checkReadback(wrong, card)).toMatchObject({ night: false, ok: false });
  });

  test("a wrong house number, unit or ZIP fails the address", () => {
    for (const [from, to] of [
      ["1847", "1874"],
      ["4B", "4D"],
      ["43215", "43251"],
    ] as const) {
      const wrong = GOOD.map((line) => line.replace(from, to));
      expect(checkReadback(wrong, card).address, `${from}->${to}`).toBe(false);
    }
  });

  test("an empty transcript passes nothing", () => {
    expect(checkReadback([], card)).toEqual({ name: false, night: false, address: false, ok: false });
  });
});
