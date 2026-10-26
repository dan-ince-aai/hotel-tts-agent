import { describe, expect, test } from "vitest";
import { SYSTEMS, type System, VOICE_NAMES, type VoiceName } from "./design.ts";
import { StudyApi } from "./api.ts";
import { cardById, formatAddress, formatNight } from "./cards.ts";
import { CALL_COLUMNS, callFailure, callRows, SESSION_COLUMNS, sessionRows, toCsv } from "./export.ts";
import { MemoryStore, type StudyCall } from "./store.ts";

function fullIds(): Record<VoiceName, Record<System, string>> {
  const ids = {} as Record<VoiceName, Record<System, string>>;
  for (const voice of VOICE_NAMES) {
    ids[voice] = {} as Record<System, string>;
    for (const system of SYSTEMS) ids[voice][system] = `${system}-${voice}`;
  }
  return ids;
}

const RATED = { naturalness: 4, tone: 3, accuracy: 5 };

/** A participant with one answered session whose calls both went cleanly. */
async function scenario(options: { email?: string; standIn?: boolean } = {}) {
  const store = new MemoryStore();
  const ids = fullIds();
  const api = new StudyApi({
    store,
    grid: options.standIn ? { ids, oursStandIn: "cartesia" } : { ids },
    studySeed: "export",
  });
  const { participant } = await api.signIn({ email: options.email ?? "a@assemblyai.com" });
  const view = await api.startSession({ participant });
  const calls = await store.calls(view.session);
  for (const call of calls) {
    await store.recordCallEvent(call.token, { type: "connected" });
    await store.recordCallEvent(call.token, { type: "spoke" });
    await store.recordCallEvent(call.token, { type: "completed" });
  }
  return { store, api, participant, view, calls };
}

/** What a good agent says on a call, built from the call's card. */
async function readBackPerfectly(store: MemoryStore, call: StudyCall) {
  const card = cardById(call.cardId);
  if (!card) throw new Error("no card");
  const spelled = [...card.last.toUpperCase()].join("-");
  for (const text of [
    `${card.first} ${card.last}, ${spelled}. Which night?`,
    `${formatNight(card.night)}. And your address?`,
    `${formatAddress(card)} - is that right?`,
  ]) {
    await store.recordUtterance("rt", { callToken: call.token, role: "agent", text });
  }
}

describe("sessionRows", () => {
  test("one scored row per session, in the analysis columns, with the hidden design", async () => {
    const { store, api, participant, view, calls } = await scenario();
    for (const call of calls) await readBackPerfectly(store, call);
    await api.submitResponse({ participant, session: view.session, preference: -2, reasons: ["human", "speed"], call1: RATED, call2: RATED });

    const [row] = sessionRows(await store.dump());
    const session = await store.session(view.session);
    expect(Object.keys(row ?? {})).toEqual([...SESSION_COLUMNS, "allocation"]);
    expect(row).toMatchObject({
      participant_id: "p0000",
      session_index: 1,
      competitor: session?.competitor,
      voice: session?.voice,
      ours_call: session?.oursFirst ? 1 : 2,
      preference: -2,
      reasons: "human;speed",
      call1_naturalness: 4,
      scored: true,
      allocation: "balanced",
      setup_failure_reason: null,
      fatal_tts_ours: false,
      ck_slow_llm: false,
      readback_ok_ours: true,
      readback_ok_competitor: true,
    });
  });

  test("setup failures are unscored with a reason; a dropped call retried to the end still counts", async () => {
    const { store, calls } = await scenario();
    const [one, two] = calls as [StudyCall, StudyCall];
    await store.recordCallEvent(one.token, { type: "dropped" }); // dropped, then completed: fine
    expect(sessionRows(await store.dump())[0]).toMatchObject({ scored: true });

    await store.recordCallEvent(two.token, { type: "skipped" });
    expect(sessionRows(await store.dump())[0]).toMatchObject({ scored: false, setup_failure_reason: "skipped_failing" });
  });

  test("the failure rule, call by call", () => {
    const base: StudyCall = {
      token: "t", sessionId: "s", position: 1, system: "ours", cellKey: "ours:jane", provider: "assemblyai",
      voiceId: "x", cellSource: "clone", cardId: "c01", attempts: 1, connected: true, spoke: true, drops: 0,
      skipped: false, completed: true, fatalTts: false, fatalError: null,
    };
    expect(callFailure(base)).toBeNull();
    expect(callFailure({ ...base, connected: false })).toBe("call_never_connected");
    expect(callFailure({ ...base, skipped: true })).toBe("skipped_failing");
    expect(callFailure({ ...base, spoke: false })).toBe("never_spoke");
    expect(callFailure({ ...base, drops: 2, completed: false })).toBe("only_dropped");
    // A model defect — a fatal TTS error mid-call on a call that otherwise ran — stays in.
    expect(callFailure({ ...base, fatalTts: true })).toBeNull();
  });

  test("flags slow LLM replies and fatal TTS errors by system", async () => {
    const { store, calls } = await scenario();
    const ours = calls.find((c) => c.system === "ours") as StudyCall;
    await store.recordTurn("rt", ours.token, {
      wholeTurnMs: 4000, endOfSpeechMs: 500, modelFirstWordMs: 3100, voiceFirstSoundMs: 150, interrupted: false,
    });
    await store.recordCallEvent(ours.token, { type: "fatal", code: "tts", message: "boom" });
    expect(sessionRows(await store.dump())[0]).toMatchObject({
      ck_slow_llm: true,
      fatal_tts_ours: true,
      fatal_tts_competitor: false,
    });
  });

  test("a wrong read-back is flagged on that system only; no transcript is blank", async () => {
    const { store, calls } = await scenario();
    const ours = calls.find((c) => c.system === "ours") as StudyCall;
    await store.recordUtterance("rt", { callToken: ours.token, role: "agent", text: "Hello there." });
    const [row] = sessionRows(await store.dump());
    expect(row?.readback_ok_ours).toBe(false);
    expect(row?.readback_ok_competitor).toBeUndefined();
  });

  test("rehearsal sessions and smoke-test sign-ins are left out unless asked for, then marked", async () => {
    const rehearsal = await scenario({ standIn: true });
    expect(sessionRows(await rehearsal.store.dump())).toHaveLength(0);
    expect(sessionRows(await rehearsal.store.dump(), { includeAll: true })[0]).toMatchObject({ rehearsal: true });

    const smoke = await scenario({ email: "smoke@example.com" });
    expect(sessionRows(await smoke.store.dump())).toHaveLength(0);
    expect(sessionRows(await smoke.store.dump(), { includeAll: true })[0]).toMatchObject({ test_participant: true });
  });
});

describe("callRows and CSV", () => {
  test("one row per call with its cell, counters and transcript", async () => {
    const { store, calls } = await scenario();
    await readBackPerfectly(store, calls[0] as StudyCall);
    await store.recordUtterance("rt", { callToken: (calls[0] as StudyCall).token, role: "caller", text: "Hi, it's me" });
    const rows = callRows(await store.dump());
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0] ?? {})).toEqual([...CALL_COLUMNS]);
    expect(rows[0]).toMatchObject({ position: 1, attempts: 1, readback_name: true, caller_transcript: "Hi, it's me" });
  });

  test("toCsv quotes commas, quotes and newlines, and writes blanks for nulls", () => {
    const csv = toCsv(["a", "b", "c"], [{ a: 'say "hi", ok', b: null, c: "line\nbreak" }]);
    expect(csv).toBe('a,b,c\n"say ""hi"", ok",,"line\nbreak"\n');
  });
});
