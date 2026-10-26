import { describe, expect, test } from "vitest";
import { SYSTEMS, type System, VOICE_NAMES } from "./study/design.ts";
import voiceIds from "./study/voice-ids.json" with { type: "json" };
import {
  cellKey,
  gridOptionsFromEnv,
  resolveCell,
  resolveGrid,
  SYSTEM_MODEL,
  VOICE_IDS,
  VOICE_LANGUAGE,
  type VoiceIdTable,
} from "./voices.ts";

/** A grid with every cell filled, `<system>-<voice>`, so ids are traceable. */
function fullIds(): VoiceIdTable {
  return Object.fromEntries(
    VOICE_NAMES.map((voice) => [
      voice,
      Object.fromEntries(SYSTEMS.map((system) => [system, `${system}-${voice}`])) as Record<System, string>,
    ]),
  );
}

/** One voice's row of a table, asserted present. */
function row(ids: VoiceIdTable, voice: string): Record<System, string> {
  const found = ids[voice];
  if (!found) throw new Error(`no row ${voice}`);
  return found;
}

describe("the voice list", () => {
  test("is study/voice-ids.json, one voice per row with all four systems", () => {
    expect(VOICE_NAMES).toEqual(voiceIds.voices.map((v) => v.slug));
    expect(VOICE_NAMES.length).toBeGreaterThanOrEqual(6);
    for (const voice of VOICE_NAMES) {
      expect(Object.keys(row(VOICE_IDS, voice)).sort()).toEqual([...SYSTEMS].sort());
    }
  });

  test("ours is an AssemblyAI library voice id for every voice", () => {
    for (const voice of VOICE_NAMES) expect(row(VOICE_IDS, voice).ours).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("knows each recording's language", () => {
    expect(VOICE_LANGUAGE["aai-audrey"]).toBe("en");
    expect(VOICE_LANGUAGE["aai-magdalena"]).toBe("de");
    expect(VOICE_LANGUAGE["aai-malvina"]).toBe("es");
  });
});

describe("the voice grid", () => {
  test("resolves a cell per system and voice, keyed system:voice", () => {
    const cells = resolveGrid({ ids: fullIds() });
    expect(cells).toHaveLength(VOICE_NAMES.length * SYSTEMS.length);
    expect(new Set(cells.map((c) => c.key)).size).toBe(cells.length);
    expect(cells.every((c) => c.source === "clone")).toBe(true);
    expect(resolveCell("inworld", "aai-ewald", { ids: fullIds() })).toMatchObject({
      key: "inworld:aai-ewald",
      provider: "inworld",
      voiceId: "inworld-aai-ewald",
      model: SYSTEM_MODEL.inworld,
    });
  });

  test("refuses to resolve with a cell missing, naming every missing cell", () => {
    const ids = fullIds();
    row(ids, "aai-audrey").cartesia = "";
    row(ids, "aai-kyla").elevenlabs = "";
    expect(() => resolveGrid({ ids })).toThrow(/cartesia:aai-audrey, .*elevenlabs:aai-kyla/);
  });

  test("the checked-in grid still needs its clones, unless stock voices are allowed", () => {
    // Competitor columns start blank until scripts/clone_voices.py fills them.
    if (VOICE_NAMES.some((v) => row(VOICE_IDS, v).cartesia === "")) {
      expect(() => resolveGrid()).toThrow(/clone_voices/);
    }
    expect(resolveGrid({ allowMissing: true })).toHaveLength(VOICE_NAMES.length * SYSTEMS.length);
  });

  test("a stand-in speaks the ours column with the competitor's clone of the same voice", () => {
    const ids = fullIds();
    row(ids, "aai-steven").ours = "";
    expect(resolveCell("ours", "aai-steven", { ids, oursStandIn: "cartesia" })).toMatchObject({
      system: "ours",
      key: "ours:aai-steven",
      provider: "cartesia",
      voiceId: "cartesia-aai-steven",
      source: "standin",
    });
    expect(resolveCell("cartesia", "aai-steven", { ids, oursStandIn: "cartesia" }).source).toBe("clone");
  });

  test("allowMissing fills an empty cell with the provider's stock voice, and says so", () => {
    const ids = fullIds();
    row(ids, "aai-carrie").inworld = "";
    const cell = resolveCell("inworld", "aai-carrie", { ids, allowMissing: true });
    expect(cell.source).toBe("stock");
    expect(cell.voiceId).toBeUndefined();
  });

  test("an unknown voice is an error, not a silent stock voice", () => {
    expect(() => resolveCell("ours", "aai-nobody", { allowMissing: true })).toThrow(/no voice/);
  });

  test("reads the knobs from the server env, refusing an unknown stand-in", () => {
    expect(gridOptionsFromEnv({})).toEqual({ oursStandIn: undefined, allowMissing: false });
    expect(gridOptionsFromEnv({ STUDY_OURS_STANDIN: "cartesia", STUDY_ALLOW_MISSING_VOICES: "1" })).toEqual({
      oursStandIn: "cartesia",
      allowMissing: true,
    });
    expect(() => gridOptionsFromEnv({ STUDY_OURS_STANDIN: "ours" })).toThrow();
    expect(() => gridOptionsFromEnv({ STUDY_OURS_STANDIN: "rime" })).toThrow();
  });

  test("cellKey spells the cell", () => {
    expect(cellKey("ours", "aai-audrey")).toBe("ours:aai-audrey");
  });
});
