import { SYSTEMS, type System, VOICE_NAMES, type VoiceName } from "./study/design.ts";
import voiceIds from "./study/voice-ids.json" with { type: "json" };

/**
 * The voice grid: each voice is one reference recording, spoken by every system, so within a
 * session the TTS MODEL is the only thing the caller can hear change.
 *
 * The ids live in `study/voice-ids.json`, one row per voice. `ours` is the AssemblyAI library
 * voice made from the recording; the competitor columns are clones of the same recording,
 * filled in by `scripts/clone_voices.py`. This file resolves a (system, voice) pair to the
 * provider, model and voice id the LiveKit agent should speak it with; the agent builds the
 * TTS itself.
 *
 * The server refuses to start with any cell missing: a study that silently swapped a stock
 * voice into one cell would be comparing voices, not models. Two escape hatches, both set in
 * the server's env and both marking every session they touch as rehearsal:
 *
 * - `STUDY_OURS_STANDIN=cartesia` (or another competitor) speaks the "ours" column with that
 *   competitor's clones.
 * - `STUDY_ALLOW_MISSING_VOICES=1` fills an empty cell with the provider's stock voice, so the
 *   whole flow runs end to end before the clones exist. Never for real data.
 */

/** The provider that speaks a system's column. */
export type VoiceProvider = "assemblyai" | "cartesia" | "elevenlabs" | "inworld";

export const SYSTEM_PROVIDER: Record<System, VoiceProvider> = {
  ours: "assemblyai",
  cartesia: "cartesia",
  elevenlabs: "elevenlabs",
  inworld: "inworld",
};

/** The model each system is pinned to (the protocol's table). */
export const SYSTEM_MODEL: Record<System, string> = {
  ours: "assemblyai-tts-1",
  cartesia: "sonic-3.6-2026-08-27",
  elevenlabs: "eleven_v4_turbo",
  inworld: "inworld-tts-2-flash",
};

interface VoiceRow {
  slug: string;
  name: string;
  language: string;
  ours: string;
  cartesia: string;
  elevenlabs: string;
  inworld: string;
}

/** Each voice's ids by system. An empty string is a clone not made yet. */
export type VoiceIdTable = Record<VoiceName, Record<System, string>>;

export const VOICE_IDS: VoiceIdTable = Object.fromEntries(
  (voiceIds.voices as VoiceRow[]).map((row) => [
    row.slug,
    { ours: row.ours, cartesia: row.cartesia, elevenlabs: row.elevenlabs, inworld: row.inworld },
  ]),
);

/** The language of each voice's recording (`en`, `de`, `es`), by slug. */
export const VOICE_LANGUAGE: Record<VoiceName, string> = Object.fromEntries(
  (voiceIds.voices as VoiceRow[]).map((row) => [row.slug, row.language]),
);

/** The server-side knobs that change how cells resolve (see the module comment). */
export interface GridOptions {
  /** Speak the "ours" column with this competitor's clones (rehearsal). */
  oursStandIn?: Exclude<System, "ours"> | undefined;
  /** Fill empty cells with stock voices (development only). */
  allowMissing?: boolean | undefined;
  /** The id table — injectable for tests; defaults to {@link VOICE_IDS}. */
  ids?: VoiceIdTable | undefined;
}

/** One cell of the grid, resolved: who speaks it, with which voice id. */
export interface VoiceCell {
  readonly system: System;
  readonly voice: VoiceName;
  /** `ours:aai-audrey` — never sent to the page. */
  readonly key: string;
  /** The provider that ACTUALLY speaks this cell (differs for a stand-in). */
  readonly provider: VoiceProvider;
  readonly model: string;
  /** The provider's voice id, or `undefined` for its stock voice. */
  readonly voiceId: string | undefined;
  /** How this cell came to be: a real voice, a stand-in, or a stock fallback. */
  readonly source: "clone" | "standin" | "stock";
}

export function cellKey(system: System, voice: VoiceName): string {
  return `${system}:${voice}`;
}

/** Read the grid knobs from the server's env. Throws on a value it does not know. */
export function gridOptionsFromEnv(env: Record<string, string | undefined>): GridOptions {
  const standIn = env.STUDY_OURS_STANDIN?.trim() || undefined;
  if (standIn !== undefined && (standIn === "ours" || !SYSTEMS.includes(standIn as System))) {
    throw new Error(
      `STUDY_OURS_STANDIN=${standIn} is not a competitor; expected one of ` +
        `${SYSTEMS.filter((s) => s !== "ours").join(", ")}.`,
    );
  }
  return {
    oursStandIn: standIn as GridOptions["oursStandIn"],
    allowMissing: env.STUDY_ALLOW_MISSING_VOICES === "1",
  };
}

/** Resolve one cell, or throw naming it if it is missing and no fallback is allowed. */
export function resolveCell(system: System, voice: VoiceName, options: GridOptions = {}): VoiceCell {
  const ids = options.ids ?? VOICE_IDS;
  const row = ids[voice];
  if (row === undefined) throw new Error(`no voice ${voice} in study/voice-ids.json`);
  const speaker: System = system === "ours" && options.oursStandIn ? options.oursStandIn : system;
  const provider = SYSTEM_PROVIDER[speaker];
  const id = row[speaker];
  const base = { system, voice, key: cellKey(system, voice), provider, model: SYSTEM_MODEL[speaker] };
  if (id !== "") {
    return { ...base, voiceId: id, source: speaker === system ? "clone" : "standin" };
  }
  if (options.allowMissing) {
    return { ...base, voiceId: undefined, source: "stock" };
  }
  throw new Error(`voice cell ${base.key} has no ${speaker} id in study/voice-ids.json`);
}

/** Every cell, or one error listing EVERY missing cell at once. */
export function resolveGrid(options: GridOptions = {}): VoiceCell[] {
  const cells: VoiceCell[] = [];
  const missing: string[] = [];
  for (const voice of VOICE_NAMES) {
    for (const system of SYSTEMS) {
      try {
        cells.push(resolveCell(system, voice, options));
      } catch {
        missing.push(cellKey(system, voice));
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} of ${VOICE_NAMES.length * SYSTEMS.length} voice cells have no id in ` +
        `study/voice-ids.json: ${missing.join(", ")}. Run scripts/clone_voices.py, or set ` +
        "STUDY_OURS_STANDIN for a rehearsal / STUDY_ALLOW_MISSING_VOICES=1 for local development.",
    );
  }
  return cells;
}
