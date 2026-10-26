import { describe, expect, test } from "vitest";
import { SYSTEMS, type System, VOICE_NAMES } from "./design.ts";
import { AgentApi } from "./agent-api.ts";
import { StudyApi } from "./api.ts";
import { AGENT_NAME, callAccess, liveKitConfigFromEnv } from "./livekit.ts";
import { MemoryStore } from "./store.ts";
import type { VoiceIdTable } from "../voices.ts";

function fullIds(): VoiceIdTable {
  return Object.fromEntries(
    VOICE_NAMES.map((voice) => [
      voice,
      Object.fromEntries(SYSTEMS.map((system) => [system, `${system}-${voice}`])) as Record<System, string>,
    ]),
  );
}

async function setup() {
  const store = new MemoryStore();
  const api = new StudyApi({ store, grid: { ids: fullIds() }, studySeed: "agent" });
  const { participant } = await api.signIn({ email: "a@assemblyai.com" });
  const view = await api.startSession({ participant });
  const calls = await store.calls(view.session);
  return { store, api, agent: new AgentApi(store), participant, view, calls };
}

/** The payload of a JWT, without verifying it — what a curious browser could read. */
function readJwt(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("the agent's view of a call", () => {
  test("is the call's cell: system, provider, voice id, pinned model and voice language", async () => {
    const { agent, calls, store, view } = await setup();
    const session = await store.session(view.session);
    for (const call of calls) {
      const cell = await agent.cell(call.token);
      expect(cell).toMatchObject({
        call: call.token,
        system: call.system,
        provider: call.provider,
        voiceId: `${call.system}-${session?.voice}`,
      });
      expect(cell.model.length).toBeGreaterThan(0);
      expect(["en", "de", "es"]).toContain(cell.voiceLanguage);
    }
  });

  test("an unknown call is 404, a finished one 409", async () => {
    const { agent, api, calls } = await setup();
    await expect(agent.cell("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ status: 404 });
    const first = calls[0]?.token ?? "";
    await api.callEvent({ call: first, type: "completed" });
    await expect(agent.cell(first)).rejects.toMatchObject({ status: 409 });
  });
});

describe("the agent's reports", () => {
  test("land on the call: attempts, spoke, fatal TTS, transcript and turns", async () => {
    const { agent, store, calls } = await setup();
    const token = calls[0]?.token ?? "";
    await agent.record(token, {
      room: "call-1",
      events: [
        { type: "connected" },
        { type: "spoke" },
        { type: "utterance", role: "agent", text: "Hello, thanks for calling." },
        { type: "utterance", role: "caller", text: "Hi." },
        {
          type: "turn",
          wholeTurnMs: 900,
          endOfSpeechMs: 300,
          modelFirstWordMs: 250,
          voiceFirstSoundMs: 110,
          interrupted: false,
        },
        { type: "fatal", code: "tts", message: "socket closed" },
      ],
    });
    // A retry is a second room: a second attempt.
    await agent.record(token, { room: "call-2", events: [{ type: "connected" }] });

    expect(await store.call(token)).toMatchObject({
      attempts: 2,
      connected: true,
      spoke: true,
      fatalTts: true,
      fatalError: "tts: socket closed",
    });
    expect(await store.callForRuntime("call-1")).toBe(token);
    const dump = await store.dump();
    expect(dump.utterances.map((u) => [u.role, u.text])).toEqual([
      ["agent", "Hello, thanks for calling."],
      ["caller", "Hi."],
    ]);
    expect(dump.turns).toEqual([
      {
        callToken: token,
        wholeTurnMs: 900,
        endOfSpeechMs: 300,
        modelFirstWordMs: 250,
        voiceFirstSoundMs: 110,
        interrupted: false,
      },
    ]);
  });

  test("a malformed report is a 400 and records nothing", async () => {
    const { agent, store, calls } = await setup();
    const token = calls[0]?.token ?? "";
    await expect(
      agent.record(token, { room: "r", events: [{ type: "connected" }, { type: "teleported" }] }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await store.call(token))?.attempts).toBe(0);
  });
});

describe("joining a call", () => {
  const config = { url: "wss://example.livekit.cloud", apiKey: "APIkey", apiSecret: "s".repeat(40) };

  test("only the call's own participant can join it, and only while it is open", async () => {
    const { api, participant, calls } = await setup();
    const token = calls[0]?.token ?? "";
    await expect(api.openCall({ participant, call: token })).resolves.toMatchObject({ call: { token } });
    const other = await api.signIn({ email: "b@assemblyai.com" });
    await expect(api.openCall({ participant: other.participant, call: token })).rejects.toMatchObject({
      status: 404,
    });
    await api.callEvent({ call: token, type: "skipped" });
    await expect(api.openCall({ participant, call: token })).rejects.toMatchObject({ status: 409 });
  });

  test("the LiveKit token dispatches the desk with only the opaque call token", async () => {
    const { calls } = await setup();
    const call = calls[0];
    if (!call) throw new Error("no call");
    const access = await callAccess(config, "0", call.token);
    expect(access.url).toBe(config.url);
    expect(access.room).toMatch(/^call-/);

    const claims = readJwt(access.token);
    const wire = JSON.stringify(claims).toLowerCase();
    expect(wire).toContain(AGENT_NAME);
    expect(wire).toContain(call.token);
    // Nothing a curious browser could decode names the system, the provider or the voice.
    for (const word of ["ours", "cartesia", "elevenlabs", "inworld", "assemblyai", call.cellKey.split(":")[1] ?? ""]) {
      expect(wire).not.toContain(word);
    }
  });

  test("each attempt gets its own room", async () => {
    const { calls } = await setup();
    const token = calls[0]?.token ?? "";
    const [a, b] = await Promise.all([callAccess(config, "0", token), callAccess(config, "0", token)]);
    expect(a.room).not.toBe(b.room);
  });

  test("calls are off until all three LiveKit settings are set", () => {
    expect(liveKitConfigFromEnv({})).toBeUndefined();
    expect(liveKitConfigFromEnv({ LIVEKIT_URL: "wss://x", LIVEKIT_API_KEY: "k" })).toBeUndefined();
    expect(liveKitConfigFromEnv({ LIVEKIT_URL: "wss://x", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" })).toEqual({
      url: "wss://x",
      apiKey: "k",
      apiSecret: "s",
    });
  });
});
