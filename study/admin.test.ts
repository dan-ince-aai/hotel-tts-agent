import { describe, expect, test } from "vitest";
import { adminSummary } from "./admin.ts";
import { StudyApi } from "./api.ts";
import { SYSTEMS, type System, VOICE_NAMES, type VoiceName } from "./design.ts";
import { sessionRows } from "./export.ts";
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

/** Run `n` sessions for one participant, every call clean, each answered with `prefer`. */
async function run(store: MemoryStore, api: StudyApi, email: string, prefer: "ours" | "them", n: number) {
  const { participant } = await api.signIn({ email });
  for (let i = 0; i < n; i++) {
    const view = await api.startSession({ participant });
    const calls = await store.calls(view.session);
    for (const call of calls) {
      await store.recordCallEvent(call.token, { type: "connected" });
      await store.recordCallEvent(call.token, { type: "spoke" });
      await store.recordCallEvent(call.token, { type: "completed" });
    }
    const oursPosition = (calls.find((c) => c.system === "ours") as StudyCall).position;
    const wantsCall = prefer === "ours" ? oursPosition : 3 - oursPosition;
    await api.submitResponse({
      participant,
      session: view.session,
      preference: wantsCall === 1 ? -2 : 2,
      reasons: [],
      call1: RATED,
      call2: RATED,
    });
  }
  return participant;
}

describe("adminSummary", () => {
  test("totals and head-to-head tallies re-signed toward ours, whichever call ours was", async () => {
    const store = new MemoryStore();
    const api = new StudyApi({ store, grid: { ids: fullIds() }, studySeed: "admin" });
    await run(store, api, "a@assemblyai.com", "ours", 6);
    await run(store, api, "b@assemblyai.com", "them", 3);

    const summary = adminSummary(await store.dump());
    expect(summary.totals).toMatchObject({ participants: 2, sessions: 9, finished: 9, answered: 9, scored: 9 });
    const wins = summary.headToHead.reduce((n, h) => n + h.oursWins, 0);
    const losses = summary.headToHead.reduce((n, h) => n + h.competitorWins, 0);
    expect([wins, losses]).toEqual([6, 3]);
    for (const h of summary.headToHead) expect(h.compared).toBe(h.oursWins + h.ties + h.competitorWins);
    // Every call connected, spoke and was rated.
    const ours = summary.systems.find((s) => s.system === "ours");
    expect(ours).toMatchObject({ calls: 9, spoke: 9, completed: 9 });
    expect(summary.ratings.find((r) => r.system === "ours")).toMatchObject({ n: 9, naturalness: 4, accuracy: 5 });
  });

  test("agrees with the export on what is scored", async () => {
    const store = new MemoryStore();
    const api = new StudyApi({ store, grid: { ids: fullIds() }, studySeed: "admin" });
    await run(store, api, "a@assemblyai.com", "ours", 2);
    const [first] = await store.calls((await store.dump()).sessions[0]?.id ?? "");
    await store.recordCallEvent(first?.token ?? "", { type: "skipped" });

    const dump = await store.dump();
    const summary = adminSummary(dump);
    const exported = sessionRows(dump);
    expect(summary.totals.scored).toBe(exported.filter((r) => r.scored === true).length);
    expect(summary.totals.setupFailures).toEqual({ skipped_failing: 1 });
    expect(summary.recent.find((s) => s.failure !== null)?.failure).toBe("skipped_failing");
  });

  test("hides rehearsal and smoke-test sessions unless asked, and says how many", async () => {
    const store = new MemoryStore();
    const api = new StudyApi({ store, grid: { ids: fullIds() }, studySeed: "admin" });
    await run(store, api, "real@assemblyai.com", "ours", 1);
    await run(store, api, "smoke+test@assemblyai.com", "ours", 2);

    const filtered = adminSummary(await store.dump());
    expect(filtered.totals.sessions).toBe(1);
    expect(filtered.hiddenSessions).toBe(2);

    const all = adminSummary(await store.dump(), { includeAll: true });
    expect(all.totals.sessions).toBe(3);
    expect(all.recent.filter((s) => s.test)).toHaveLength(2);
  });

  test("lists recent sessions newest first, capped", async () => {
    const store = new MemoryStore();
    const api = new StudyApi({ store, grid: { ids: fullIds() }, studySeed: "admin" });
    await run(store, api, "a@assemblyai.com", "ours", 4);
    const summary = adminSummary(await store.dump(), { recent: 2 });
    expect(summary.recent).toHaveLength(2);
    expect((summary.recent[0]?.createdAt ?? "") >= (summary.recent[1]?.createdAt ?? "")).toBe(true);
  });
});
