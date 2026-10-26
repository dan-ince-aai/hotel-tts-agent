import { describe, expect, test } from "vitest";
import { SYSTEMS, type System, VOICE_NAMES, type VoiceName } from "./study/design.ts";
import {
  cellKey,
  gridOptionsFromEnv,
  resolveCell,
  resolveGrid,
  SYSTEM_MODEL,
  ttsForCell,
  VOICE_IDS,
} from "./voices.ts";

/** A grid with every cell filled, `<system>-<voice>`, so ids are traceable. */
function fullIds(): Record<VoiceName, Record<System, string>> {
  const ids = {} as Record<VoiceName, Record<System, string>>;
  for (const voice of VOICE_NAMES) {
    ids[voice] = {} as Record<System, string>;
    for (const system of SYSTEMS) ids[voice][system] = `${system}-${voice}`;
  }
  return ids;
}

describe("the voice grid", () => {
  test("has a cell for every voice in every system", () => {
    expect(Object.keys(VOICE_IDS).sort()).toEqual([...VOICE_NAMES].sort());
    for (const voice of VOICE_NAMES) {
      expect(Object.keys(VOICE_IDS[voice]).sort()).toEqual([...SYSTEMS].sort());
    }
  });

  test("resolves sixteen cells, one per system and voice, keyed system:voice", () => {
    const cells = resolveGrid({ ids: fullIds() });
    expect(cells).toHaveLength(16);
    expect(new Set(cells.map((c) => c.key)).size).toBe(16);
    expect(cells.every((c) => c.source === "clone")).toBe(true);
    expect(resolveCell("inworld", "eli", { ids: fullIds() })).toMatchObject({
      key: "inworld:eli",
      provider: "inworld",
      voiceId: "inworld-eli",
      model: SYSTEM_MODEL.inworld,
    });
  });

  test("refuses to resolve with a cell missing, naming every missing cell", () => {
    const ids = fullIds();
    ids.jane.ours = "";
    ids.charles.elevenlabs = "";
    expect(() => resolveGrid({ ids })).toThrow(/ours:jane, .*elevenlabs:charles/);
  });

  test("a stand-in speaks the ours column with the competitor's clone of the same voice", () => {
    const ids = fullIds();
    ids.shirley.ours = "";
    const cell = resolveCell("ours", "shirley", { ids, oursStandIn: "cartesia" });
    expect(cell).toMatchObject({
      system: "ours",
      key: "ours:shirley",
      provider: "cartesia",
      voiceId: "cartesia-shirley",
      source: "standin",
    });
    // Competitor cells are untouched by the stand-in.
    expect(resolveCell("cartesia", "shirley", { ids, oursStandIn: "cartesia" }).source).toBe("clone");
  });

  test("allowMissing fills an empty cell with the provider's stock voice, and says so", () => {
    const ids = fullIds();
    ids.eli.cartesia = "";
    const cell = resolveCell("cartesia", "eli", { ids, allowMissing: true });
    expect(cell.source).toBe("stock");
    expect(cell.voiceId).toBeUndefined();
    expect(resolveGrid({ ids, allowMissing: true })).toHaveLength(16);
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

  test("cellKey spells the engine key", () => {
    expect(cellKey("ours", "jane")).toBe("ours:jane");
  });
});

describe("ttsForCell", () => {
  const ids = fullIds();

  test("turns each system's cells into that provider's descriptor, with the clone and the pinned model", () => {
    const expectedKind: Record<System, string> = {
      ours: "assemblyai",
      cartesia: "cartesia",
      elevenlabs: "elevenlabs",
      inworld: "inworld",
    };
    for (const system of SYSTEMS) {
      const tts = ttsForCell(resolveCell(system, "jane", { ids }));
      expect(tts.kind).toBe(expectedKind[system]);
      expect(tts.options.voice).toBe(`${system}-jane`);
      // AssemblyAI's streaming TTS takes no model field; the others are pinned.
      if (system !== "ours") expect(tts.options.model).toBe(SYSTEM_MODEL[system]);
    }
  });

  test("a stock-voice cell leaves the voice to the descriptor's default", () => {
    const sparse = fullIds();
    sparse.jane.elevenlabs = "";
    const tts = ttsForCell(resolveCell("elevenlabs", "jane", { ids: sparse, allowMissing: true }));
    expect(tts.options.voice).toBeUndefined();
  });
});
