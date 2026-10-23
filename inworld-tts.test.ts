import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  INWORLD_API_KEY_ENV,
  INWORLD_DEFAULT_MODEL,
  INWORLD_DEFAULT_VOICE,
  INWORLD_TTS_KIND,
  inworldTts,
  resolveInworldTtsSettings,
} from "./inworld-tts.ts";
import { openInworld, registerInworldTts, splitSentences } from "./inworld-tts-host.ts";

/**
 * The Inworld connector, offline. The descriptor half is pure, so it is tested
 * as the ElevenLabs one is. The host half is driven against a fake WebSocket
 * stubbed over the global one, which pins the wire messages this connector
 * sends and its reaction to the frames Inworld documents — no network. The live
 * proof that Inworld actually speaks is `inworld-smoke.ts`, which spends money
 * and needs the key, so it is a script rather than a spec.
 */
describe("inworldTts", () => {
  test("returns an inert `inworld` descriptor carrying only the set options", () => {
    const tts = inworldTts({ voice: "Ashley" });
    expect(tts.kind).toBe(INWORLD_TTS_KIND);
    expect(tts.options).toEqual({ voice: "Ashley" });
  });

  test("threads model, language and an apiKeyEnv override through verbatim", () => {
    const tts = inworldTts({
      voice: "Dennis",
      model: "inworld-tts-2",
      language: "en-US",
      apiKeyEnv: "INWORLD_API_KEY_STAGING",
    });
    expect(tts.options).toEqual({
      voice: "Dennis",
      model: "inworld-tts-2",
      language: "en-US",
      apiKeyEnv: "INWORLD_API_KEY_STAGING",
    });
  });

  test("omits unset options rather than writing undefined", () => {
    const tts = inworldTts();
    expect(tts.options).toEqual({});
    expect("voice" in tts.options).toBe(false);
  });

  test("names the INWORLD_API_KEY env var the opener reads", () => {
    expect(INWORLD_API_KEY_ENV).toBe("INWORLD_API_KEY");
  });
});

describe("resolveInworldTtsSettings", () => {
  test("fills the host-side defaults when the descriptor names none", () => {
    expect(resolveInworldTtsSettings({})).toEqual({
      voice: INWORLD_DEFAULT_VOICE,
      model: "inworld-tts-2-flash",
      language: undefined,
    });
    expect(INWORLD_DEFAULT_MODEL).toBe("inworld-tts-2-flash");
  });

  test("prefers the descriptor's own options over the defaults", () => {
    expect(resolveInworldTtsSettings({ voice: "v", model: "m", language: "fr-FR" })).toEqual({
      voice: "v",
      model: "m",
      language: "fr-FR",
    });
  });
});

describe("splitSentences", () => {
  test("splits finished sentences off the front and keeps the unfinished rest", () => {
    expect(splitSentences("Welcome to the hotel. How can I help? I can")).toEqual({
      sentences: ["Welcome to the hotel. ", "How can I help? "],
      rest: "I can",
    });
  });

  test("waits for the whitespace after a period before ending a sentence", () => {
    expect(splitSentences("It costs 3.5")).toEqual({ sentences: [], rest: "It costs 3.5" });
    expect(splitSentences("Thanks.")).toEqual({ sentences: [], rest: "Thanks." });
  });

  test("does not end a sentence at an abbreviation, an initial or an ellipsis", () => {
    const text = "Dr. Smith checks in at 7 a.m. tomorrow, says J. Doe... maybe. Then";
    expect(splitSentences(text)).toEqual({
      sentences: ["Dr. Smith checks in at 7 a.m. tomorrow, says J. Doe... maybe. "],
      rest: "Then",
    });
  });

  test("keeps a closing quote with its sentence and ends at CJK terminators", () => {
    expect(splitSentences('She said "yes." Next')).toEqual({
      sentences: ['She said "yes." '],
      rest: "Next",
    });
    expect(splitSentences("你好。谢谢")).toEqual({ sentences: ["你好。"], rest: "谢谢" });
  });
});

/** A stand-in for Node's global WebSocket, recording what the opener does. */
class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly sent: Record<string, unknown>[] = [];
  readyState = 0;
  closedWith: number | undefined;
  constructor(
    readonly url: string,
    readonly init: { headers: Record<string, string> },
  ) {
    super();
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }, 0);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  /** Deliver one server frame. */
  receive(frame: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
  /** Drop the connection from the server side. */
  serverClose(code: number) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
  }
}

const pcmBase64 = (...samples: number[]) =>
  Buffer.from(new Int16Array(samples).buffer).toString("base64");

async function openSession(opts = {}, sampleRate = 24_000) {
  const session = await openInworld(opts).open({
    apiKey: "a2V5OnNlY3JldA==",
    sampleRate,
    signal: new AbortController().signal,
  });
  const ws = FakeWebSocket.instances.at(-1)!;
  const events: { audio: number[][]; done: number; errors: string[] } = {
    audio: [],
    done: 0,
    errors: [],
  };
  session.on("audio", (pcm) => events.audio.push([...pcm]));
  session.on("done", () => events.done++);
  session.on("error", (err) => events.errors.push(err.message));
  return { session, ws, events };
}

describe("openInworld (against a fake socket)", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("dials the bidirectional endpoint with Basic auth and creates a PCM context", async () => {
    const { ws } = await openSession({ voice: "Ashley", language: "en-US" }, 16_000);
    expect(ws.url).toBe("wss://api.inworld.ai/tts/v1/voice:streamBidirectional");
    expect(ws.init.headers).toEqual({ Authorization: "Basic a2V5OnNlY3JldA==" });
    expect(ws.sent[0]).toEqual({
      contextId: expect.any(String),
      create: {
        voiceId: "Ashley",
        modelId: "inworld-tts-2-flash",
        audioConfig: { audioEncoding: "PCM", sampleRateHertz: 16_000 },
        language: "en-US",
      },
    });
  });

  test("flushes each finished sentence, then the tail and a close on flush()", async () => {
    const { session, ws, events } = await openSession();
    const ctx = ws.sent[0]!.contextId;
    session.sendText("Good evening");
    session.sendText(". Your room is ready");
    expect(ws.sent.slice(1)).toEqual([
      { contextId: ctx, send_text: { text: "Good evening. ", flush_context: {} } },
    ]);
    session.flush();
    expect(ws.sent.slice(2)).toEqual([
      { contextId: ctx, send_text: { text: "Your room is ready", flush_context: {} } },
      { contextId: ctx, close_context: {} },
    ]);

    ws.receive({ result: { contextId: ctx, audioChunk: { audioContent: pcmBase64(1, -2, 300) } } });
    ws.receive({ result: { contextId: ctx, flushCompleted: {} } });
    expect(events.done).toBe(0);
    ws.receive({ result: { contextId: ctx, contextClosed: {} } });
    expect(events.audio).toEqual([[1, -2, 300]]);
    expect(events.done).toBe(1);
    await session.close();
  });

  test("carries an odd trailing byte into the next chunk instead of dropping it", async () => {
    const { session, ws, events } = await openSession();
    const ctx = ws.sent[0]!.contextId;
    const bytes = Buffer.from(new Int16Array([7, 8, 9]).buffer);
    const send = (b: Buffer) =>
      ws.receive({ result: { contextId: ctx, audioChunk: { audioContent: b.toString("base64") } } });
    send(bytes.subarray(0, 3));
    send(bytes.subarray(3));
    expect(events.audio).toEqual([[7], [8, 9]]);
    await session.close();
  });

  test("a barge-in emits done at once, drops the old context's audio and starts a new one", async () => {
    const { session, ws, events } = await openSession();
    const first = ws.sent[0]!.contextId;
    session.sendText("Let me check that for you. One");
    session.cancel();
    expect(events.done).toBe(1);
    expect(ws.sent.at(-1)).toEqual({ contextId: first, close_context: {} });

    ws.receive({ result: { contextId: first, audioChunk: { audioContent: pcmBase64(5) } } });
    ws.receive({ result: { contextId: first, status: { code: 5, message: "gone" } } });
    ws.receive({ result: { contextId: first, contextClosed: {} } });
    expect(events.audio).toEqual([]);
    expect(events.errors).toEqual([]);
    expect(events.done).toBe(1);

    session.sendText("Sure. ");
    const create = ws.sent.find((m) => "create" in m && m.contextId !== first);
    expect(create).toBeDefined();
    const second = create!.contextId;
    expect(ws.sent.at(-1)).toEqual({
      contextId: second,
      send_text: { text: "Sure. ", flush_context: {} },
    });
    session.flush();
    ws.receive({ result: { contextId: second, contextClosed: {} } });
    expect(events.done).toBe(2);
    await session.close();
  });

  test("reports an error on the live context, and an unclean server close", async () => {
    const { session, ws, events } = await openSession();
    const ctx = ws.sent[0]!.contextId;
    ws.receive({ result: { contextId: ctx, status: { code: 3, message: "Unknown voice" } } });
    expect(events.errors).toEqual(["Inworld TTS: Unknown voice (status 3)"]);
    ws.serverClose(1011);
    expect(events.errors.at(-1)).toBe("Inworld TTS: socket closed 1011");
    expect(events.done).toBe(1);
    await session.close();
  });

  test("close() closes the live context and the socket, once", async () => {
    const { session, ws } = await openSession();
    const ctx = ws.sent[0]!.contextId;
    await session.close();
    await session.close();
    expect(ws.sent.filter((m) => "close_context" in m)).toEqual([
      { contextId: ctx, close_context: {} },
    ]);
    expect(ws.closedWith).toBe(1000);
  });

  test("refuses a missing key and an out-of-range sample rate before dialling", async () => {
    const signal = new AbortController().signal;
    await expect(openInworld({}).open({ apiKey: "", sampleRate: 24_000, signal })).rejects.toThrow(
      /INWORLD_API_KEY/,
    );
    await expect(openInworld({}).open({ apiKey: "k", sampleRate: 96_000, signal })).rejects.toThrow(
      /unsupported sample rate/,
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe("registerInworldTts", () => {
  test("registers the kind and hands back an unregister function", () => {
    const unregister = registerInworldTts();
    expect(typeof unregister).toBe("function");
    unregister();
  });
});
