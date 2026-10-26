import type { TtsProvider } from "@alexkroman1/aai";
import { assemblyAITts, cartesiaTts } from "@alexkroman1/aai/tts";
import { elevenLabsTts } from "./elevenlabs-tts.ts";
import { inworldTts } from "./inworld-tts.ts";
import { SYSTEMS, type System, VOICE_NAMES, type VoiceName } from "./study/design.ts";

/**
 * The voice grid: four voices, each one reference recording cloned into all four
 * systems, so within a session the TTS MODEL is the only thing the caller can
 * hear change. This is the one file you edit when a clone lands.
 *
 * ```
 *             ours (AssemblyAI)   Cartesia   ElevenLabs   Inworld
 *   jane           cell             cell        cell        cell
 *   shirley        cell             cell        cell        cell
 *   eli            cell             cell        cell        cell
 *   charles        cell             cell        cell        cell
 * ```
 *
 * Read across a row and every cell is a clone of the same clip. The server builds
 * one engine per cell (sixteen) and refuses to start with any cell missing — a
 * study that silently swapped a stock voice into one cell would be comparing
 * voices, not models. Two escape hatches exist for before the clones are done,
 * both set in the server's env and both recorded on every call they touch:
 *
 * - `STUDY_OURS_STANDIN=cartesia` (or another competitor) speaks the "ours"
 *   column with that competitor's clones — the protocol's rehearsal setup, which
 *   ran with Cartesia standing in for our model.
 * - `STUDY_ALLOW_MISSING_VOICES=1` fills an empty cell with the provider's stock
 *   voice, so the whole flow runs end to end in development. Never for real data.
 */

/** The provider that speaks a system's column. */
export type VoiceProvider = "assemblyai" | "cartesia" | "elevenlabs" | "inworld";

export const SYSTEM_PROVIDER: Record<System, VoiceProvider> = {
  ours: "assemblyai",
  cartesia: "cartesia",
  elevenlabs: "elevenlabs",
  inworld: "inworld",
};

/**
 * The model each system is pinned to — the protocol's table. AssemblyAI's
 * streaming TTS takes no model field (the production host serves
 * `assemblyai-tts-1`), so it is listed for the record and not sent.
 */
export const SYSTEM_MODEL: Record<System, string> = {
  ours: "assemblyai-tts-1",
  cartesia: "sonic-3.6-2026-08-27",
  elevenlabs: "eleven_v4_turbo",
  inworld: "inworld-tts-2-flash",
};

/**
 * The cloned voice id in every cell. An empty string is a clone not made yet.
 *
 * Jane and Charles are the original studio recordings behind the Pocket TTS
 * presets of those names (10–12 s each); Shirley and Eli are Voice Pool v2
 * readers (HiFiTTS-2 / LibriVox `en:librivox:10252` and `en:librivox:11357`).
 * Every id here must come from the account whose key the server runs with —
 * a clone lives in the account that made it.
 */
export const VOICE_IDS: Record<VoiceName, Record<System, string>> = {
  jane: { ours: "", cartesia: "", elevenlabs: "", inworld: "" },
  shirley: { ours: "", cartesia: "", elevenlabs: "", inworld: "" },
  eli: { ours: "", cartesia: "", elevenlabs: "", inworld: "" },
  charles: { ours: "", cartesia: "", elevenlabs: "", inworld: "" },
};

/**
 * Each provider's stock voice — the `STUDY_ALLOW_MISSING_VOICES` fallback only.
 * Undefined means "the descriptor's own default".
 */
const STOCK_VOICE: Record<VoiceProvider, string | undefined> = {
  assemblyai: "jane",
  cartesia: undefined,
  elevenlabs: undefined,
  inworld: undefined,
};

/** The server-side knobs that change how cells resolve (see the module comment). */
export interface GridOptions {
  /** Speak the "ours" column with this competitor's clones (rehearsal). */
  oursStandIn?: Exclude<System, "ours"> | undefined;
  /** Fill empty cells with stock voices (development only). */
  allowMissing?: boolean | undefined;
  /** The id table — injectable for tests; defaults to {@link VOICE_IDS}. */
  ids?: Record<VoiceName, Record<System, string>> | undefined;
}

/** One cell of the grid, resolved: who speaks it, with which voice id. */
export interface VoiceCell {
  readonly system: System;
  readonly voice: VoiceName;
  /** `ours:jane` — the engine key the server routes on. Never sent to the page. */
  readonly key: string;
  /** The provider that ACTUALLY speaks this cell (differs for a stand-in). */
  readonly provider: VoiceProvider;
  readonly model: string;
  /** The provider's voice id, or `undefined` for its stock voice. */
  readonly voiceId: string | undefined;
  /** How this cell came to be: a real clone, a stand-in, or a stock fallback. */
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
  const speaker: System = system === "ours" && options.oursStandIn ? options.oursStandIn : system;
  const provider = SYSTEM_PROVIDER[speaker];
  const id = ids[voice][speaker];
  const base = { system, voice, key: cellKey(system, voice), provider, model: SYSTEM_MODEL[speaker] };
  if (id !== "") {
    return { ...base, voiceId: id, source: speaker === system ? "clone" : "standin" };
  }
  if (options.allowMissing) {
    return { ...base, voiceId: STOCK_VOICE[provider], source: "stock" };
  }
  throw new Error(`voice cell ${base.key} has no ${speaker} clone id in voices.ts`);
}

/**
 * All sixteen cells, or one error listing EVERY missing cell — so a deploy with
 * three clones outstanding says all three at once rather than one per restart.
 */
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
      `${missing.length} of ${VOICE_NAMES.length * SYSTEMS.length} voice cells have no clone id ` +
        `in voices.ts: ${missing.join(", ")}. Clone them, or set STUDY_OURS_STANDIN for a ` +
        `rehearsal / STUDY_ALLOW_MISSING_VOICES=1 for local development.`,
    );
  }
  return cells;
}

/**
 * Turn a cell into the `tts` descriptor `agent({ tts })` takes. Each factory
 * returns pure data (no socket, no key read); the host resolves it at session
 * start. ElevenLabs and Inworld are this project's own connectors and speak once
 * the server has registered their openers.
 */
export function ttsForCell(cell: VoiceCell): TtsProvider {
  const voice = cell.voiceId;
  switch (cell.provider) {
    case "assemblyai":
      return assemblyAITts(voice === undefined ? {} : { voice });
    case "cartesia":
      return cartesiaTts({ model: cell.model, ...(voice === undefined ? {} : { voice }) });
    case "elevenlabs":
      return elevenLabsTts({ model: cell.model, ...(voice === undefined ? {} : { voice }) });
    case "inworld":
      return inworldTts({ model: cell.model, ...(voice === undefined ? {} : { voice }) });
  }
}
