import type { TtsProvider } from "@alexkroman1/aai";
import type { ProviderCredentialOptions } from "@alexkroman1/aai/tts";

/**
 * Inworld TTS — the DESCRIPTOR half (the second provider we build ourselves).
 *
 * The toolkit ships speaking support for AssemblyAI, Cartesia and Rime only, so
 * Inworld, like ElevenLabs, is a part we add. It splits exactly as
 * `elevenlabs-tts.ts` does, and for the same reason: this file is PURE — a
 * factory that returns `{ kind, options }` data and reads no key and opens no
 * socket — so `voices.ts` (and through it the agent bundle) can import it
 * without dragging a WebSocket or any host code into the guest. The HOST half —
 * the thing that opens the connection and hands back sound — lives in
 * `inworld-tts-host.ts` and is registered with `registerTtsKind` by the server.
 * Until that registration runs in a process, an `inworld` descriptor is inert
 * data.
 *
 * {@link resolveInworldTtsSettings} is the one place the descriptor's options
 * meet their host-side defaults, shared by the factory's callers and the opener
 * so the settings reported are by construction the ones dialled.
 */

/** Kind tag the host-side resolver matches — see `registerInworldTts`. */
export const INWORLD_TTS_KIND = "inworld";

/** Agent-env variable the Inworld API key is read from at session start. */
export const INWORLD_API_KEY_ENV = "INWORLD_API_KEY";

/**
 * Default model. TTS-2 Flash is Inworld's lowest-latency model (the id is
 * `inworld-tts-2-flash` on https://docs.inworld.ai/tts/tts-models) — the right
 * default for a voice agent, and the like-for-like peer of ElevenLabs Flash.
 */
export const INWORLD_DEFAULT_MODEL = "inworld-tts-2-flash";

/**
 * Default voice (Ashley, one of Inworld's built-in voices), used only when a
 * caller names none. `voices.ts` always passes a voice, so this is a safety
 * net, not the study's choice.
 */
export const INWORLD_DEFAULT_VOICE = "Ashley";

/** Options for {@link inworldTts}. Mirrors the ElevenLabs descriptor's shape. */
export interface InworldTtsOptions extends ProviderCredentialOptions {
  /** Inworld voice id (a built-in name such as `Ashley`, or a cloned voice id). */
  voice?: string;
  /** Model id. Defaults to {@link INWORLD_DEFAULT_MODEL}. */
  model?: string;
  /**
   * Spoken-language hint, sent as the context's `language`. Inworld wants a
   * BCP-47 tag (`en-US`), NOT the ISO 639-1 code the ElevenLabs descriptor
   * takes. Omitted by default — Inworld then auto-detects from the text.
   */
  language?: string;
}

/**
 * Build an Inworld TTS descriptor for pipeline mode — a pure `{ kind, options }`
 * value. The API key is resolved host-side from the agent's env
 * (`INWORLD_API_KEY`) when the opener this kind registers is opened.
 */
export function inworldTts(options: InworldTtsOptions = {}): TtsProvider {
  const opts: Record<string, unknown> = {};
  if (options.voice !== undefined) opts.voice = options.voice;
  if (options.model !== undefined) opts.model = options.model;
  if (options.language !== undefined) opts.language = options.language;
  if (options.apiKeyEnv !== undefined) opts.apiKeyEnv = options.apiKeyEnv;
  return { kind: INWORLD_TTS_KIND, options: opts };
}

/** The descriptor's options with every host-side default filled in. */
export function resolveInworldTtsSettings(options: InworldTtsOptions): {
  voice: string;
  model: string;
  language: string | undefined;
} {
  return {
    voice: options.voice ?? INWORLD_DEFAULT_VOICE,
    model: options.model ?? INWORLD_DEFAULT_MODEL,
    language: options.language,
  };
}
