/**
 * The automatic read-back check: did the agent read the caller's name, night
 * and address back right?
 *
 * It matters for fairness. A read-back can go wrong for reasons that are not the
 * TTS — the recogniser mishears a detail and the agent faithfully reads back the
 * wrong thing (about 3 in 120 read-backs in rehearsal), or the LLM slips a
 * letter. Those calls are flagged so the analysis can run a read-backs-right-only
 * sensitivity fit, and so a reviewer can see by system whether the misses cluster.
 *
 * The check reads the agent's TEXT (what went into the TTS), against the call's
 * persona card. It is deliberately tolerant of form and strict on content:
 *
 * - **Name** — first and last name both said, and the last name spelled back
 *   letter by letter in order (`T-H-O-M-P-S-O-N`, `T, H, O…`, `T H O…`).
 * - **Night** — the month and the day (`March 21st`, `21st of March`, `3/21`).
 * - **Address** — the house number, the street name, the unit, the city and the
 *   ZIP. The street type and state are left out: `Dr`/`Drive` and `OH`/`Ohio`
 *   are both right, and either form proves nothing about the TTS.
 *
 * A caller who strays from their card (gives a different night, say) will fail
 * the check even if the agent echoed them perfectly; the per-part result in the
 * calls export is there so a reviewer can tell those apart.
 */
import type { PersonaCard } from "./cards.ts";

export interface ReadbackResult {
  name: boolean;
  night: boolean;
  address: boolean;
  /** All three. */
  ok: boolean;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A word or phrase, case-insensitively, on word boundaries, flexible on spacing. */
function hasPhrase(text: string, phrase: string): boolean {
  const pattern = phrase.trim().split(/\s+/).map(escape).join("[\\s,.-]+");
  return new RegExp(`(^|[^a-z0-9])${pattern}($|[^a-z0-9])`, "i").test(text);
}

/** The last name spelled letter by letter, any separators, in order. */
function hasSpelling(text: string, word: string): boolean {
  const letters = [...word.toLowerCase()].filter((c) => /[a-z]/.test(c)).map(escape);
  const pattern = letters.join("[\\s,.\\-–—]+");
  return new RegExp(`(^|[^a-z])${pattern}($|[^a-z])`, "i").test(text);
}

function hasNight(text: string, isoDate: string): boolean {
  const [, monthText, dayText] = isoDate.split("-");
  const month = Number(monthText);
  const day = Number(dayText);
  const name = MONTHS[month - 1] ?? "";
  const short = name.slice(0, 3);
  const dayPattern = `${day}(st|nd|rd|th)?`;
  const monthPattern = `(${name}|${short}\\.?)`;
  return [
    new RegExp(`\\b${monthPattern}\\s+(the\\s+)?${dayPattern}\\b`, "i"),
    new RegExp(`\\b(the\\s+)?${dayPattern}\\s+(of\\s+)?${monthPattern}\\b`, "i"),
    new RegExp(`\\b0?${month}/0?${day}\\b`),
  ].some((pattern) => pattern.test(text));
}

function hasAddress(text: string, card: PersonaCard): boolean {
  const a = card.address;
  // The unit's identifier without its label: `Apt 4B` → `4B`, `Unit 12` → `12`.
  const unitId = a.unit.split(/\s+/).at(-1) ?? a.unit;
  return (
    hasPhrase(text, a.number) &&
    hasPhrase(text, a.street) &&
    hasPhrase(text, unitId) &&
    hasPhrase(text, a.city) &&
    hasPhrase(text, a.zip)
  );
}

/** Check everything the agent said on one call against that call's card. */
export function checkReadback(agentText: readonly string[], card: PersonaCard): ReadbackResult {
  const text = agentText.join("\n");
  const name = hasPhrase(text, card.first) && hasPhrase(text, card.last) && hasSpelling(text, card.last);
  const night = hasNight(text, card.night);
  const address = hasAddress(text, card);
  return { name, night, address, ok: name && night && address };
}
