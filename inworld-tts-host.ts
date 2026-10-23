import { registerTtsKind } from "@alexkroman1/aai-runtime";
import type {
  TtsError,
  TtsEvents,
  TtsOpener,
  TtsOpenOptions,
  TtsSession,
  Unsubscribe,
} from "@alexkroman1/aai-runtime";
import { createTtsError } from "@alexkroman1/aai/host-internal";
import { randomUUID } from "node:crypto";
import {
  INWORLD_API_KEY_ENV,
  INWORLD_TTS_KIND,
  resolveInworldTtsSettings,
  type InworldTtsOptions,
} from "./inworld-tts.ts";

/**
 * Inworld TTS — the HOST half (the second provider we build ourselves).
 *
 * The descriptor half (`inworld-tts.ts`) is pure data; this is the part that
 * does the work: it opens Inworld's bidirectional streaming WebSocket when a
 * call starts, feeds it the model's words, and emits the sound back on the same
 * {@link TtsEvents} contract the pipeline consumes from every provider. Register
 * it once with {@link registerInworldTts} in the HOST process (the server;
 * `inworld-smoke.ts` for a standalone proof) and an `inworld` row then resolves
 * and speaks like any AssemblyAI, Cartesia or ElevenLabs row.
 *
 * It is modelled on `elevenlabs-tts-host.ts`, which is modelled on the
 * toolkit's Cartesia opener: one socket per session, one Inworld *context* per
 * turn, and a fresh context minted after each `flush()`/`cancel()` so a
 * barge-in only ever drops the in-flight turn. Each turn's context is
 * explicitly closed rather than left dangling, so a long call never piles up
 * live contexts on the one socket.
 *
 * Unlike ElevenLabs, the context runs in Inworld's MANUAL mode (`autoMode`
 * off): nothing is synthesized until it is flushed. So the text is cut into
 * sentences here, on the host, and each finished sentence goes out with its own
 * `flush_context` — the first sentence speaks while the model is still writing
 * the rest, and a sentence is never spoken as a fragment. The pipeline's
 * `flush()` releases whatever unfinished tail is left and closes the context;
 * Inworld answers `contextClosed` after the turn's last audio, which is the
 * normal turn-end `done`.
 *
 * Wire facts, from the API reference
 * (https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech-websocket):
 * the client sends `create` / `send_text` / `flush_context` / `close_context`
 * beside a top-level `contextId`; the server answers in a `result` envelope
 * (`audioChunk.audioContent` base64, `flushCompleted`, `contextClosed`, and a
 * gRPC-style `status`). Auth is `Authorization: Basic <INWORLD_API_KEY>` on the
 * upgrade request (https://docs.inworld.ai/api-reference/introduction) — a
 * header a browser WebSocket cannot set, but Node's built-in one (undici) takes
 * a non-standard `{ headers }` init, so no `ws` dependency is needed.
 */

/** Inworld's bidirectional TTS endpoint. */
const INWORLD_WS_URL = "wss://api.inworld.ai/tts/v1/voice:streamBidirectional";

/** `audioConfig.sampleRateHertz` range Inworld accepts. */
const INWORLD_MIN_SAMPLE_RATE = 8000;
const INWORLD_MAX_SAMPLE_RATE = 48000;

/** Inworld's cap on one `send_text`, in UTF-16 code units. */
const MAX_SEND_CHARS = 2000;

/** How long to wait for the socket to open before giving up. */
const CONNECT_TIMEOUT_MS = 10_000;

/** `WebSocket.OPEN`, spelled out so the opener reads no static off the global. */
const WS_OPEN = 1;

/**
 * Fallbacks for the turn-end `done` the pipeline waits on. Inworld sends
 * `contextClosed` for a closed context, and that is the normal path; these
 * cover the case where it does not arrive. {@link FIRST_AUDIO_TIMEOUT_MS} is the
 * grace for the first chunk after a flush (synthesis has to start),
 * {@link QUIESCENCE_MS} the gap after the last chunk that means the turn has
 * drained. Longer than the ElevenLabs connector's 400 ms because one pipeline
 * flush can release several sentence-sized syntheses back to back, each with
 * its own first-byte wait between them.
 */
const FIRST_AUDIO_TIMEOUT_MS = 8_000;
const QUIESCENCE_MS = 1_000;

/** Closing marks that travel with the sentence they close. */
const CLOSERS = "[\"'”’)\\]」』）]*";

/**
 * A sentence ends at `.`, `!` or `?` followed by whitespace (Latin and Cyrillic
 * script), or right after the CJK, Arabic or Devanagari terminators, which take
 * no space — ported, in miniature, from Inworld's own client-segmentation guide
 * (https://github.com/inworld-ai/inworld-api-examples/tree/main/tts/python/websocket_guides/client_segmentation).
 */
const SENTENCE_END = new RegExp(`[.!?]+${CLOSERS}\\s+|[。！？؟।॥]+${CLOSERS}`, "gu");

/** English words whose trailing period does not end a sentence. */
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "jr",
  "sr",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "a.m",
  "p.m",
]);

/**
 * Split the finished sentences off the front of `text`. Returns them (each with
 * its trailing whitespace) and the unfinished rest. A period after an
 * abbreviation or a single-letter initial, and an ellipsis, do not end one.
 * Exported for the unit tests.
 */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const mark = match[0];
    const at = match.index;
    if (mark.startsWith("..")) continue;
    if (mark.startsWith(".")) {
      const word = (text.slice(start, at).split(/\s+/).pop() ?? "")
        .replace(/^["'“‘(\[]+/u, "")
        .toLowerCase();
      if (ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word)) continue;
    }
    const end = at + mark.length;
    sentences.push(text.slice(start, end));
    start = end;
  }
  return { sentences, rest: text.slice(start) };
}

/**
 * Cut `text` into pieces no longer than {@link MAX_SEND_CHARS}, at the last
 * whitespace before the limit where there is one. A run-on with no sentence end
 * still goes out, a piece at a time, rather than outgrowing one `send_text`.
 */
function chunkForSend(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > MAX_SEND_CHARS) {
    const space = rest.lastIndexOf(" ", MAX_SEND_CHARS);
    const cut = space > 0 ? space + 1 : MAX_SEND_CHARS;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * A PCM16-LE decoder that carries a stray odd byte into the next chunk rather
 * than dropping it — a dropped byte would shift every later sample by half and
 * turn the rest of the turn into noise. It also strips a RIFF/WAV header if one
 * ever arrives: `PCM` is documented header-free, but Inworld's own guide strips
 * defensively and so does this. Reset it per context.
 */
function createPcm16Decoder() {
  let carry: Buffer | undefined;
  return {
    decode(b64: string): Int16Array {
      let bytes: Buffer = stripWavHeader(Buffer.from(b64, "base64"));
      if (carry) {
        bytes = Buffer.concat([carry, bytes]);
        carry = undefined;
      }
      if (bytes.byteLength % 2 === 1) {
        carry = Buffer.from(bytes.subarray(bytes.byteLength - 1));
        bytes = bytes.subarray(0, bytes.byteLength - 1);
      }
      const pcm = new Int16Array(bytes.byteLength >> 1);
      for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i << 1);
      return pcm;
    },
    reset() {
      carry = undefined;
    },
  };
}

/** The PCM payload of a chunk, without its RIFF/WAV header if it has one. */
function stripWavHeader(bytes: Buffer): Buffer {
  if (bytes.byteLength < 12) return bytes;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    return bytes;
  }
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = bytes.toString("ascii", pos, pos + 4);
    const size = bytes.readUInt32LE(pos + 4);
    if (id === "data") return bytes.subarray(pos + 8);
    pos += 8 + size;
  }
  return Buffer.alloc(0);
}

/** A single-shot timer that can be re-armed or cleared — the quiescence clock. */
function createRestartableTimer(onFire: () => void) {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return {
    arm(ms: number) {
      if (handle !== undefined) clearTimeout(handle);
      handle = setTimeout(() => {
        handle = undefined;
        onFire();
      }, ms);
    },
    pending: () => handle !== undefined,
    clear() {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}

type AnyListener = (...args: never[]) => void;

/**
 * The session scaffolding every opener repeats, inlined so this connector leans
 * on no unpublished toolkit internal: a `closed` latch, an idempotent `close()`,
 * a typed emit/subscribe surface, and the rule that nothing fans out once the
 * session is closed and a listener's throw never escapes a socket handler.
 */
function createShell(teardown: () => void) {
  const listeners = new Map<keyof TtsEvents, Set<AnyListener>>();
  let closed = false;
  const contain = (fan: () => void) => {
    if (closed) return;
    try {
      fan();
    } catch {
      // A caller-supplied listener's throw must not escape the raw socket
      // handler that fired the event (an uncaughtException on a shared host).
    }
  };
  const emit = <E extends keyof TtsEvents>(event: E, ...args: Parameters<TtsEvents[E]>) =>
    contain(() => {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of [...set]) (fn as (...a: Parameters<TtsEvents[E]>) => void)(...args);
    });
  const on = <E extends keyof TtsEvents>(event: E, fn: TtsEvents[E]): Unsubscribe => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(fn as AnyListener);
    return () => {
      set.delete(fn as AnyListener);
    };
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      teardown();
    } catch {
      // teardown is best-effort — the socket may already be gone.
    }
  };
  const streamError = (message: string) => emit("error", createTtsError("tts_stream_error", message));
  return { isClosed: () => closed, close, emit, on, streamError };
}

/**
 * The `done`-once-per-turn latch. The pipeline advances the turn on `done`, so a
 * duplicate — the server's `contextClosed` racing the quiescence timer or a
 * cancel — would advance it mid-reply.
 */
function createDoneLatch(isClosed: () => boolean, emitDone: () => void) {
  let emitted = false;
  return {
    emitted: () => emitted,
    emitOnce() {
      if (emitted || isClosed()) return;
      emitted = true;
      emitDone();
    },
    rearm() {
      emitted = false;
    },
  };
}

/**
 * The error a server frame carries, if any: a top-level `error` (seen in
 * Inworld's JS example) or a non-zero gRPC `status.code` inside `result`.
 */
function frameError(msg: Record<string, unknown>, result: Record<string, unknown> | undefined) {
  const err = msg.error as { message?: unknown; code?: unknown } | undefined;
  if (err && typeof err === "object") {
    return typeof err.message === "string" ? err.message : JSON.stringify(err);
  }
  const status = result?.status as { code?: unknown; message?: unknown } | undefined;
  if (status && typeof status.code === "number" && status.code !== 0) {
    const text = typeof status.message === "string" && status.message ? status.message : "error";
    return `${text} (status ${status.code})`;
  }
  return undefined;
}

/** Resolve once the socket opens, or reject on error, abort, or timeout. */
function waitForOpen(ws: WebSocket, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fail = (err: TtsError) => {
      cleanup();
      try {
        ws.close();
      } catch {
        // already closing
      }
      reject(err);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    // A rejected key fails the upgrade (401/403), which the WebSocket API
    // reports only as a bare error — so the message names the likely cause.
    const onError = () =>
      fail(
        createTtsError(
          "tts_connect_failed",
          `Inworld TTS: connect failed (check ${INWORLD_API_KEY_ENV})`,
        ),
      );
    const onAbort = () =>
      fail(createTtsError("tts_connect_failed", "Inworld TTS: aborted before connect"));
    const timer = setTimeout(
      () => fail(createTtsError("tts_connect_failed", "Inworld TTS: connect timed out")),
      CONNECT_TIMEOUT_MS,
    );
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Node's global WebSocket (undici) with its non-standard `{ headers }` init —
 * the only way to put Inworld's Basic credential on the upgrade request without
 * a third-party client. The DOM typings do not know the overload, hence the cast.
 */
type HeaderWebSocketCtor = new (
  url: string,
  init: { headers: Record<string, string> },
) => WebSocket;

/** Build a {@link TtsOpener} from resolved Inworld descriptor options. */
export function openInworld(opts: InworldTtsOptions): TtsOpener {
  return {
    name: INWORLD_TTS_KIND,
    async open(openOpts: TtsOpenOptions): Promise<TtsSession> {
      const { sampleRate, signal } = openOpts;
      // The Portal's copy is the bare Base64 credential; tolerate one pasted
      // with its `Basic ` prefix, since a doubled prefix is a silent 401.
      const apiKey = (openOpts.apiKey || "").trim().replace(/^Basic\s+/i, "");
      if (!apiKey) {
        throw createTtsError(
          "tts_auth_failed",
          `Inworld TTS: missing API key. Set ${INWORLD_API_KEY_ENV} in the agent env.`,
        );
      }
      if (
        !Number.isInteger(sampleRate) ||
        sampleRate < INWORLD_MIN_SAMPLE_RATE ||
        sampleRate > INWORLD_MAX_SAMPLE_RATE
      ) {
        throw createTtsError(
          "tts_connect_failed",
          `Inworld TTS: unsupported sample rate ${sampleRate}. ` +
            `Supported: ${INWORLD_MIN_SAMPLE_RATE}–${INWORLD_MAX_SAMPLE_RATE} Hz.`,
        );
      }
      const { voice, model, language } = resolveInworldTtsSettings(opts);

      const HeaderWebSocket = WebSocket as unknown as HeaderWebSocketCtor;
      const ws = new HeaderWebSocket(INWORLD_WS_URL, {
        headers: { Authorization: `Basic ${apiKey}` },
      });
      await waitForOpen(ws, signal);

      let quiescence!: ReturnType<typeof createRestartableTimer>;
      // Declared before the shell so its teardown can close the live context.
      let context = randomUUID();
      let contextCloseSent = false;
      const shell = createShell(() => {
        quiescence?.clear();
        try {
          if (ws.readyState === WS_OPEN && !contextCloseSent) {
            ws.send(JSON.stringify({ contextId: context, close_context: {} }));
          }
        } catch {
          // best-effort — fall through to close()
        }
        try {
          ws.close(1000, "client close");
        } catch {
          // already closing
        }
      });
      const doneLatch = createDoneLatch(shell.isClosed, () => shell.emit("done"));
      const emitDoneOnce = () => {
        quiescence.clear();
        doneLatch.emitOnce();
      };
      quiescence = createRestartableTimer(emitDoneOnce);
      const decoder = createPcm16Decoder();

      const safeSend = (payload: Record<string, unknown>) => {
        if (shell.isClosed() || ws.readyState !== WS_OPEN) return;
        try {
          ws.send(JSON.stringify(payload));
        } catch (err) {
          shell.streamError(`Inworld TTS: send failed: ${String(err)}`);
        }
      };

      /**
       * A new context with this session's voice and model, asking for raw
       * header-free PCM16 at the pipeline's rate. Manual mode (the default):
       * nothing synthesizes until a flush. Messages on a socket are processed in
       * order, so text can follow without waiting for `contextCreated`.
       */
      const createContext = (contextId: string) => {
        const create: Record<string, unknown> = {
          voiceId: voice,
          modelId: model,
          audioConfig: { audioEncoding: "PCM", sampleRateHertz: sampleRate },
        };
        if (language) create.language = language;
        safeSend({ contextId, create });
      };

      /** Close this turn's context once; Inworld synthesizes what is buffered first. */
      const closeContext = () => {
        if (contextCloseSent) return;
        contextCloseSent = true;
        safeSend({ contextId: context, close_context: {} });
      };

      /** Send text with a flush, split to fit Inworld's per-message cap. */
      const sendFlushed = (text: string) => {
        for (const piece of chunkForSend(text)) {
          safeSend({ contextId: context, send_text: { text: piece, flush_context: {} } });
        }
      };

      let pendingText = "";
      let rotatePending = false;
      let activeContextCancelled = false;
      const rotateIfPending = () => {
        if (!rotatePending) return;
        // The last turn's fallback clock must not fire into this one.
        quiescence.clear();
        context = randomUUID();
        contextCloseSent = false;
        decoder.reset();
        createContext(context);
        doneLatch.rearm();
        rotatePending = false;
        activeContextCancelled = false;
      };

      ws.addEventListener("message", (event: MessageEvent) => {
        if (shell.isClosed()) return;
        if (typeof event.data !== "string") return; // Inworld sends JSON text frames
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const result =
          msg.result && typeof msg.result === "object"
            ? (msg.result as Record<string, unknown>)
            : undefined;
        const id = typeof result?.contextId === "string" ? result.contextId : undefined;
        const forOtherContext = id !== undefined && id !== context;

        const error = frameError(msg, result);
        if (error !== undefined) {
          // A turn already dropped by barge-in, or long since finished, may
          // still answer on its old context — that is not this session's error.
          if (forOtherContext || activeContextCancelled) return;
          shell.streamError(`Inworld TTS: ${error}`);
          return;
        }
        if (!result) return;

        const chunk = result.audioChunk as { audioContent?: unknown } | undefined;
        if (chunk && typeof chunk.audioContent === "string" && chunk.audioContent.length > 0) {
          // Inworld cannot take back text it has accepted: a cancelled turn's
          // audio keeps arriving on its old context, and is dropped here.
          if (forOtherContext || activeContextCancelled) return;
          const pcm = decoder.decode(chunk.audioContent);
          if (pcm.length === 0) return;
          shell.emit("audio", pcm);
          if (quiescence.pending()) quiescence.arm(QUIESCENCE_MS);
          return;
        }
        // `contextClosed` follows the turn's last audio — the normal `done`.
        // (`flushCompleted` marks each sentence's synthesis, not the turn's.)
        if (result.contextClosed !== undefined) {
          if (forOtherContext) return;
          emitDoneOnce();
        }
      });

      ws.addEventListener("error", () => {
        if (!shell.isClosed()) shell.streamError("Inworld TTS: socket error");
      });
      // Inworld closes a socket after ~10 idle minutes; any close we did not ask
      // for ends the turn and, if not clean, is reported as the terminal error.
      ws.addEventListener("close", (event: CloseEvent) => {
        if (shell.isClosed()) return;
        emitDoneOnce();
        if (event.code !== 1000) {
          const reason = event.reason ? ` (${event.reason})` : "";
          shell.streamError(`Inworld TTS: socket closed ${event.code}${reason}`);
        }
      });

      const onAbort = () => void shell.close();
      if (signal.aborted) void shell.close();
      else signal.addEventListener("abort", onAbort, { once: true });

      // Create the first turn's context eagerly, as the Cartesia opener mints its.
      createContext(context);

      return {
        sendText(text: string) {
          if (shell.isClosed() || text.length === 0) return;
          rotateIfPending();
          const { sentences, rest } = splitSentences(pendingText + text);
          pendingText = rest;
          // Each finished sentence is flushed on its own, so it starts speaking
          // now; an over-long run-on is released before it outgrows a message.
          for (const sentence of sentences) sendFlushed(sentence);
          if (pendingText.length > MAX_SEND_CHARS) {
            sendFlushed(pendingText);
            pendingText = "";
          }
        },
        flush() {
          if (shell.isClosed() || rotatePending) return;
          // Release the unfinished tail, then close this turn's context: the
          // close finishes synthesizing first, so no audio is lost, and Inworld
          // answers `contextClosed` after the last chunk.
          if (pendingText.trim().length > 0) sendFlushed(pendingText);
          pendingText = "";
          closeContext();
          rotatePending = true;
          quiescence.arm(FIRST_AUDIO_TIMEOUT_MS);
        },
        cancel() {
          if (shell.isClosed()) return;
          pendingText = "";
          closeContext();
          activeContextCancelled = true;
          emitDoneOnce();
          rotatePending = true;
        },
        on: shell.on,
        close: shell.close,
      };
    },
  };
}

/**
 * Register the Inworld TTS kind on the host's live provider registry, so an
 * `inworld` descriptor from `voices.ts` resolves and speaks. Returns the
 * unregister function. Call it once in the HOST process before serving.
 */
export function registerInworldTts(): () => void {
  return registerTtsKind(INWORLD_TTS_KIND, {
    envVar: INWORLD_API_KEY_ENV,
    open: (descriptor) => openInworld(descriptor.options as InworldTtsOptions),
  });
}
