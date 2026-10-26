import { describe, expect, test } from "vitest";
import { SYSTEMS, type System, VOICE_NAMES, type VoiceName, sessionFor } from "./design.ts";
import { ApiError, StudyApi } from "./api.ts";
import { isTestEmail, MemoryStore } from "./store.ts";

/** A grid with every clone filled, so cells resolve as real clones. */
function fullIds(): Record<VoiceName, Record<System, string>> {
  const ids = {} as Record<VoiceName, Record<System, string>>;
  for (const voice of VOICE_NAMES) {
    ids[voice] = {} as Record<System, string>;
    for (const system of SYSTEMS) ids[voice][system] = `${system}-${voice}`;
  }
  return ids;
}

function setup(grid: ConstructorParameters<typeof StudyApi>[0]["grid"] = { ids: fullIds() }) {
  const store = new MemoryStore();
  let n = 0;
  // Valid v4-shaped UUIDs, deterministic so failures are readable.
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  return { store, api: new StudyApi({ store, grid, studySeed: "test", newId }) };
}

const RATED = { naturalness: 4, tone: 4, accuracy: 5 };

function answer(participant: string, session: string, preference = 1) {
  return { participant, session, preference, reasons: ["human"], call1: RATED, call2: RATED };
}

describe("sign-in", () => {
  test("creates a participant once per email, case- and space-insensitively", async () => {
    const { api } = setup();
    const first = await api.signIn({ email: "Dana@AssemblyAI.com " });
    const again = await api.signIn({ email: "dana@assemblyai.com" });
    expect(again.participant).toBe(first.participant);
    expect(first).toMatchObject({ completed: 0, total: 6, canContinue: true, open: false });
  });

  test("rejects a malformed email with a 400", async () => {
    const { api } = setup();
    await expect(api.signIn({ email: "not-an-email" })).rejects.toMatchObject({ status: 400 });
  });

  test("flags smoke-test addresses so they never count as study data", () => {
    expect(isTestEmail("smoke@example.com")).toBe(true);
    expect(isTestEmail("dana+test@assemblyai.com")).toBe(true);
    expect(isTestEmail("dana@assemblyai.com")).toBe(false);
  });
});

describe("a session", () => {
  test("hands out tokens and cards only — no system, voice or order", async () => {
    const { api } = setup();
    const { participant } = await api.signIn({ email: "a@assemblyai.com" });
    const view = await api.startSession({ participant });
    expect(view.index).toBe(1);
    expect(view.calls).toHaveLength(2);
    const wire = JSON.stringify(view);
    for (const word of ["ours", "cartesia", "elevenlabs", "inworld", "jane", "shirley", "eli", "charles"]) {
      expect(wire.toLowerCase()).not.toContain(word);
    }
  });

  test("stores the schedule's plan behind the tokens, with each call on the right cell", async () => {
    const { api, store } = setup();
    const { participant } = await api.signIn({ email: "a@assemblyai.com" });
    const view = await api.startSession({ participant });
    const plan = sessionFor(0, 1, "test");
    const session = await store.session(view.session);
    expect(session).toMatchObject({ competitor: plan.competitor, voice: plan.voice, oursFirst: plan.oursFirst, rehearsal: false });
    const calls = await store.calls(view.session);
    expect(calls.map((c) => c.cellKey)).toEqual(plan.calls.map((c) => `${c.system}:${plan.voice}`));
    expect(calls.map((c) => c.cardId)).toEqual(plan.calls.map((c) => c.cardId));
    expect(calls.every((c) => c.cellSource === "clone")).toBe(true);
  });

  test("resumes an unfinished session instead of handing out a new one", async () => {
    const { api } = setup();
    const { participant } = await api.signIn({ email: "a@assemblyai.com" });
    const first = await api.startSession({ participant });
    const again = await api.startSession({ participant });
    expect(again.session).toBe(first.session);
    expect((await api.progressFor({ participant })).open).toBe(true);
  });

  test("advances through six sessions, then refuses a seventh", async () => {
    const { api } = setup();
    const { participant } = await api.signIn({ email: "a@assemblyai.com" });
    for (let i = 1; i <= 6; i++) {
      const view = await api.startSession({ participant });
      expect(view.index).toBe(i);
      const progress = await api.submitResponse(answer(participant, view.session));
      expect(progress.completed).toBe(i);
    }
    expect((await api.progressFor({ participant })).canContinue).toBe(false);
    await expect(api.startSession({ participant })).rejects.toMatchObject({ status: 409 });
  });

  test("a second participant gets the next participant number's schedule", async () => {
    const { api, store } = setup();
    await api.signIn({ email: "a@assemblyai.com" });
    const { participant } = await api.signIn({ email: "b@assemblyai.com" });
    const view = await api.startSession({ participant });
    const session = await store.session(view.session);
    expect(session?.participantNumber).toBe(1);
    expect(session?.competitor).toBe(sessionFor(1, 1, "test").competitor);
  });

  test("a server on a stand-in or stock voices marks its sessions rehearsal", async () => {
    const ids = fullIds();
    for (const voice of VOICE_NAMES) (ids[voice] as Record<System, string>).ours = "";
    const { api, store } = setup({ ids, oursStandIn: "cartesia" });
    const { participant } = await api.signIn({ email: "a@assemblyai.com" });
    const view = await api.startSession({ participant });
    expect((await store.session(view.session))?.rehearsal).toBe(true);
    const ours = (await store.calls(view.session)).find((c) => c.system === "ours");
    expect(ours).toMatchObject({ provider: "cartesia", cellSource: "standin" });
  });

  test("refuses an unknown participant with a 401", async () => {
    const { api } = setup();
    await expect(api.startSession({ participant: "00000000-0000-4000-8000-999999999999" })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("call events and answers", () => {
  test("page events land on the call's counters", async () => {
    const { api, store } = setup();
    const { participant } = await api.signIn({ email: "a@assemblyai.com" });
    const view = await api.startSession({ participant });
    const [one, two] = view.calls;
    await api.callEvent({ call: one?.token, type: "dropped" });
    await api.callEvent({ call: one?.token, type: "completed" });
    await api.callEvent({ call: two?.token, type: "skipped" });
    expect(await store.call(one?.token ?? "")).toMatchObject({ drops: 1, completed: true, skipped: false });
    expect(await store.call(two?.token ?? "")).toMatchObject({ skipped: true });
    const resumed = await api.startSession({ participant });
    expect(resumed.calls.map((c) => [c.done, c.skipped])).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  test("server events: each connect is an attempt; a fatal TTS error is flagged", async () => {
    const { api, store } = setup();
    const { participant } = await api.signIn({ email: "a@assemblyai.com" });
    const token = (await api.startSession({ participant })).calls[0]?.token ?? "";
    await store.recordCallEvent(token, { type: "connected" });
    await store.recordCallEvent(token, { type: "connected" });
    await store.recordCallEvent(token, { type: "spoke" });
    await store.recordCallEvent(token, { type: "fatal", code: "tts", message: "socket closed" });
    expect(await store.call(token)).toMatchObject({
      attempts: 2,
      connected: true,
      spoke: true,
      fatalTts: true,
      fatalError: "tts: socket closed",
    });
  });

  test("an event for an unknown call is a 404", async () => {
    const { api } = setup();
    await expect(
      api.callEvent({ call: "00000000-0000-4000-8000-999999999999", type: "completed" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("the questionnaire is validated: preference −2…2, at most two reasons, ratings 1…5", async () => {
    const { api } = setup();
    const { participant } = await api.signIn({ email: "a@assemblyai.com" });
    const { session } = await api.startSession({ participant });
    await expect(api.submitResponse({ ...answer(participant, session), preference: 3 })).rejects.toMatchObject({ status: 400 });
    await expect(
      api.submitResponse({ ...answer(participant, session), reasons: ["human", "tone", "speed"] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.submitResponse({ ...answer(participant, session), call2: { ...RATED, tone: 0 } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("a session is answered once, and only by its own participant", async () => {
    const { api } = setup();
    const a = await api.signIn({ email: "a@assemblyai.com" });
    const b = await api.signIn({ email: "b@assemblyai.com" });
    const { session } = await api.startSession({ participant: a.participant });
    await expect(api.submitResponse(answer(b.participant, session))).rejects.toMatchObject({ status: 404 });
    await api.submitResponse(answer(a.participant, session));
    await expect(api.submitResponse(answer(a.participant, session))).rejects.toMatchObject({ status: 409 });
  });

  test("closing a session with a skipped call counts it toward the six, unanswered", async () => {
    const { api, store } = setup();
    const { participant } = await api.signIn({ email: "a@assemblyai.com" });
    const { session } = await api.startSession({ participant });
    const progress = await api.closeSession({ participant, session });
    expect(progress.completed).toBe(1);
    expect(await store.response(session)).toBeUndefined();
    expect((await api.startSession({ participant })).index).toBe(2);
  });
});

describe("matching weights", () => {
  async function answerAll(api: StudyApi, participant: string, view: { session: string }) {
    await api.submitResponse(answer(participant, view.session));
  }

  test("equal weights hand out the balanced block, marked balanced", async () => {
    const { api, store } = setup();
    const { participant } = await api.signIn({ email: "a@assemblyai.com" });
    const view = await api.startSession({ participant });
    const session = await store.session(view.session);
    expect(session?.allocation).toBe("balanced");
    expect(session?.competitor).toBe(sessionFor(0, 1, "test").competitor);
  });

  test("unequal weights steer new sessions to the target shares, marked weighted", async () => {
    const { api, store } = setup();
    await api.setMatching({ weights: { cartesia: 0, elevenlabs: 1, inworld: 3 } });
    const counts = { cartesia: 0, elevenlabs: 0, inworld: 0 };
    for (let p = 0; p < 20; p++) {
      const { participant } = await api.signIn({ email: `p${p}@assemblyai.com` });
      for (let k = 0; k < 2; k++) {
        const view = await api.startSession({ participant });
        const session = await store.session(view.session);
        expect(session?.allocation).toBe("weighted");
        counts[session?.competitor ?? "cartesia"]++;
        await answerAll(api, participant, view);
      }
    }
    expect(counts).toEqual({ cartesia: 0, elevenlabs: 10, inworld: 30 });
    const view = await api.matching();
    expect(view).toMatchObject({ balanced: false, sinceChange: counts, targetShare: { inworld: 0.75 } });
  });

  test("ours stays in every weighted session, first about half the time per competitor", async () => {
    const { api, store } = setup();
    await api.setMatching({ weights: { cartesia: 1, elevenlabs: 2, inworld: 1 } });
    for (let p = 0; p < 40; p++) {
      const { participant } = await api.signIn({ email: `p${p}@assemblyai.com` });
      await api.startSession({ participant });
    }
    const { sessions, calls } = await store.dump();
    for (const s of sessions) {
      const systems = calls.filter((c) => c.sessionId === s.id).map((c) => c.system);
      expect(systems).toContain("ours");
    }
    const eleven = sessions.filter((s) => s.competitor === "elevenlabs");
    expect(eleven.filter((s) => s.oursFirst).length / eleven.length).toBeCloseTo(0.5, 1);
  });

  test("rehearsal sessions do not count toward the study's shares", async () => {
    const rehearsalIds = fullIds();
    for (const voice of VOICE_NAMES) (rehearsalIds[voice] as Record<System, string>).ours = "";
    const store = new MemoryStore();
    const rehearsal = new StudyApi({ store, grid: { ids: rehearsalIds, oursStandIn: "cartesia" }, studySeed: "t" });
    await rehearsal.setMatching({ weights: { cartesia: 1, elevenlabs: 1, inworld: 2 } });
    const { participant } = await rehearsal.signIn({ email: "r@assemblyai.com" });
    await rehearsal.startSession({ participant });
    expect(Object.values((await rehearsal.matching()).sinceChange).reduce((a, b) => a + b, 0)).toBe(0);
  });

  test("refuses weights that are negative, too large, or all zero", async () => {
    const { api } = setup();
    for (const weights of [
      { cartesia: -1, elevenlabs: 1, inworld: 1 },
      { cartesia: 101, elevenlabs: 1, inworld: 1 },
      { cartesia: 0, elevenlabs: 0, inworld: 0 },
    ]) {
      await expect(api.setMatching({ weights })).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe("enabled voices", () => {
  const ENGLISH = ["aai-audrey", "aai-ewald", "aai-steven", "aai-kyla", "aai-carrie", "aai-ernest"];

  test("default to the English voices, and sessions only use those", async () => {
    const { api, store } = setup();
    const view = await api.voices();
    expect(view.changedAt).toBeNull();
    expect(view.voices.filter((v) => v.enabled).map((v) => v.slug)).toEqual(ENGLISH);
    for (let p = 0; p < 6; p++) {
      const { participant } = await api.signIn({ email: `p${p}@assemblyai.com` });
      for (let k = 0; k < 6; k++) {
        const session = await api.startSession({ participant });
        expect(ENGLISH).toContain((await store.session(session.session))?.voice);
        await api.submitResponse(answer(participant, session.session));
      }
    }
  });

  test("an admin's choice applies to new sessions", async () => {
    const { api, store } = setup();
    const saved = await api.setVoices({ enabled: ["aai-kyla", "aai-magdalena"] });
    expect(saved.changedAt).not.toBeNull();
    expect(saved.voices.filter((v) => v.enabled).map((v) => v.slug)).toEqual(["aai-kyla", "aai-magdalena"]);
    const { participant } = await api.signIn({ email: "a@assemblyai.com" });
    const view = await api.startSession({ participant });
    expect(["aai-kyla", "aai-magdalena"]).toContain((await store.session(view.session))?.voice);
  });

  test("refuses no voices, or a voice that doesn't exist", async () => {
    const { api } = setup();
    await expect(api.setVoices({ enabled: [] })).rejects.toMatchObject({ status: 400 });
    await expect(api.setVoices({ enabled: ["aai-nobody"] })).rejects.toMatchObject({ status: 400 });
  });
});
