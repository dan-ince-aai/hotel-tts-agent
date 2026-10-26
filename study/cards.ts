/**
 * The twelve persona cards a caller books with — one per call, none repeated
 * across a participant's six sessions (two calls each).
 *
 * A card gives the caller GOALS, not lines: who they are, which night they want,
 * and where they live. The agent then has to read each of those back, which is
 * exactly the material a TTS gets wrong — a spelled surname, a date, and a full
 * street address. Every address forces a house number, a street-type
 * abbreviation, a unit, a state code and a ZIP, and the LLM writes them back in
 * that written form, so each TTS does its own text normalisation.
 *
 * Names are standard American names on purpose: the test is the voice reading a
 * name back, not the recogniser coping with a rare one.
 *
 * The structured fields (not just a display string) are what the read-back
 * check in the export matches the agent's words against.
 */

export interface PersonaCard {
  /** Stable id, `c01`…`c12` — what the database records per call. */
  readonly id: string;
  readonly first: string;
  readonly last: string;
  /** The night, as an ISO date; the weekday is derived, never typed by hand. */
  readonly night: string;
  readonly address: {
    readonly number: string;
    readonly street: string;
    /** The written abbreviation the card shows: `Dr`, `Ln`, `Blvd`… */
    readonly streetType: string;
    /** The unit as written: `Apt 4B`, `Unit 12`, `Ste 210`. */
    readonly unit: string;
    readonly city: string;
    /** Two-letter state code. */
    readonly state: string;
    readonly zip: string;
  };
}

export const CARDS: readonly PersonaCard[] = [
  {
    id: "c01", first: "Jennifer", last: "Thompson", night: "2027-03-21",
    address: { number: "1847", street: "Maple Ridge", streetType: "Dr", unit: "Apt 4B", city: "Columbus", state: "OH", zip: "43215" },
  },
  {
    id: "c02", first: "Michael", last: "Anderson", night: "2027-04-09",
    address: { number: "392", street: "Oak Hollow", streetType: "Ln", unit: "Unit 12", city: "Austin", state: "TX", zip: "78704" },
  },
  {
    id: "c03", first: "Sarah", last: "Mitchell", night: "2027-05-14",
    address: { number: "5120", street: "Cedar Crest", streetType: "Blvd", unit: "Ste 210", city: "Denver", state: "CO", zip: "80206" },
  },
  {
    id: "c04", first: "David", last: "Robinson", night: "2027-06-03",
    address: { number: "76", street: "Willow Bend", streetType: "Ct", unit: "Apt 3", city: "Raleigh", state: "NC", zip: "27603" },
  },
  {
    id: "c05", first: "Emily", last: "Carter", night: "2027-07-17",
    address: { number: "2209", street: "Birchwood", streetType: "Ave", unit: "Apt 7C", city: "Minneapolis", state: "MN", zip: "55405" },
  },
  {
    id: "c06", first: "Christopher", last: "Hughes", night: "2027-08-26",
    address: { number: "418", street: "Pine Valley", streetType: "Rd", unit: "Unit 5A", city: "Nashville", state: "TN", zip: "37209" },
  },
  {
    id: "c07", first: "Jessica", last: "Morgan", night: "2027-09-11",
    address: { number: "1563", street: "Lakeshore", streetType: "Pkwy", unit: "Apt 22", city: "Madison", state: "WI", zip: "53703" },
  },
  {
    id: "c08", first: "Matthew", last: "Bennett", night: "2027-10-02",
    address: { number: "907", street: "Sycamore", streetType: "St", unit: "Apt 1F", city: "Portland", state: "OR", zip: "97214" },
  },
  {
    id: "c09", first: "Ashley", last: "Collins", night: "2027-10-29",
    address: { number: "3381", street: "Highland", streetType: "Ter", unit: "Unit 9", city: "Phoenix", state: "AZ", zip: "85016" },
  },
  {
    id: "c10", first: "Daniel", last: "Foster", night: "2027-11-12",
    address: { number: "64", street: "Chestnut Hill", streetType: "Pl", unit: "Apt 2D", city: "Richmond", state: "VA", zip: "23220" },
  },
  {
    id: "c11", first: "Amanda", last: "Reyes", night: "2027-12-04",
    address: { number: "2745", street: "Magnolia", streetType: "Way", unit: "Ste 4", city: "Tampa", state: "FL", zip: "33606" },
  },
  {
    id: "c12", first: "Joshua", last: "Parker", night: "2028-01-22",
    address: { number: "1190", street: "Aspen Grove", streetType: "Cir", unit: "Apt 6E", city: "Boise", state: "ID", zip: "83702" },
  },
];

/** The card with a given id, or `undefined`. */
export function cardById(id: string): PersonaCard | undefined {
  return CARDS.find((card) => card.id === id);
}

/** `Sunday, March 21st` — how the card shows the night. */
export function formatNight(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const weekday = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const month = date.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const day = date.getUTCDate();
  return `${weekday}, ${month} ${day}${ordinalSuffix(day)}`;
}

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/** `1847 Maple Ridge Dr, Apt 4B, Columbus, OH 43215` — the card's written form. */
export function formatAddress(card: PersonaCard): string {
  const a = card.address;
  return `${a.number} ${a.street} ${a.streetType}, ${a.unit}, ${a.city}, ${a.state} ${a.zip}`;
}

/** What the page shows for one call: the card, display-ready, and nothing else. */
export interface CardView {
  name: string;
  night: string;
  address: string;
}

export function cardView(card: PersonaCard): CardView {
  return {
    name: `${card.first} ${card.last}`,
    night: formatNight(card.night),
    address: formatAddress(card),
  };
}
