/**
 * The private API the LiveKit agent (`agent/`) talks to. Never called by the browser.
 *
 * | route | does |
 * | --- | --- |
 * | `GET /internal/calls/{token}` | the call's voice cell: who speaks it, with which voice and model |
 * | `POST /internal/calls/{token}/events` | what happened on the call, as the agent saw it |
 *
 * Both need `Authorization: Bearer {STUDY_AGENT_SECRET}`, checked by the server.
 *
 * The events are the facts the setup-failure rule and the read-back check need that only the
 * agent sees: the call CONNECTED (each room the agent joins is an attempt), the voice SPOKE, a
 * FATAL error (and whether it was the TTS's), each side's words, and every reply's timings.
 */
import { z } from "zod";
import { SYSTEM_MODEL, type VoiceProvider, VOICE_LANGUAGE } from "../voices.ts";
import { ApiError } from "./api.ts";
import type { System } from "./design.ts";
import type { StudyStore } from "./store.ts";

/** What the agent needs to speak a call. */
export interface CallCell {
  call: string;
  system: System;
  provider: VoiceProvider;
  /** `null`: the provider's stock voice (development only). */
  voiceId: string | null;
  model: string;
  /** The language of the voice's recording, e.g. `en`. */
  voiceLanguage: string;
}

/** The model a provider is pinned to. A stand-in speaks with its own provider's model. */
const PROVIDER_MODEL: Record<VoiceProvider, string> = {
  assemblyai: SYSTEM_MODEL.ours,
  cartesia: SYSTEM_MODEL.cartesia,
  elevenlabs: SYSTEM_MODEL.elevenlabs,
  inworld: SYSTEM_MODEL.inworld,
};

const ms = z.number().int().min(0).max(600_000).nullable();
const AgentEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connected") }),
  z.object({ type: z.literal("spoke") }),
  z.object({ type: z.literal("fatal"), code: z.string().max(40), message: z.string().max(2000) }),
  z.object({
    type: z.literal("utterance"),
    role: z.enum(["agent", "caller"]),
    text: z.string().max(5000),
  }),
  z.object({
    type: z.literal("turn"),
    wholeTurnMs: ms,
    endOfSpeechMs: ms,
    modelFirstWordMs: ms,
    voiceFirstSoundMs: ms,
    interrupted: z.boolean(),
  }),
]);
export const AgentEventsBody = z.object({
  room: z.string().min(1).max(200),
  events: z.array(AgentEvent).max(500),
});

export class AgentApi {
  private readonly store: StudyStore;

  constructor(store: StudyStore) {
    this.store = store;
  }

  /** The call's cell; 404 for an unknown call, 409 for one that is already over. */
  async cell(token: string): Promise<CallCell> {
    const call = await this.store.call(token);
    if (!call) throw new ApiError(404, "no such call");
    if (call.completed || call.skipped) throw new ApiError(409, "this call is already over");
    const session = await this.store.session(call.sessionId);
    if (!session) throw new ApiError(404, "no such session");
    const provider = call.provider as VoiceProvider;
    return {
      call: call.token,
      system: call.system,
      provider,
      voiceId: call.voiceId,
      model: PROVIDER_MODEL[provider],
      voiceLanguage: VOICE_LANGUAGE[session.voice] ?? "en",
    };
  }

  /** Record a batch of the agent's events against the call. */
  async record(token: string, raw: unknown): Promise<{ ok: true }> {
    const parsed = AgentEventsBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    if (!(await this.store.call(token))) throw new ApiError(404, "no such call");
    const { room, events } = parsed.data;
    for (const event of events) {
      switch (event.type) {
        case "connected":
          await this.store.linkRuntimeSession(room, token);
          await this.store.recordCallEvent(token, { type: "connected" });
          break;
        case "spoke":
          await this.store.recordCallEvent(token, { type: "spoke" });
          break;
        case "fatal":
          console.warn(`[study] call ${token} fatal ${event.code} error: ${event.message}`);
          await this.store.recordCallEvent(token, { type: "fatal", code: event.code, message: event.message });
          break;
        case "utterance":
          await this.store.recordUtterance(room, { callToken: token, role: event.role, text: event.text });
          break;
        case "turn":
          await this.store.recordTurn(room, token, {
            wholeTurnMs: event.wholeTurnMs,
            endOfSpeechMs: event.endOfSpeechMs,
            modelFirstWordMs: event.modelFirstWordMs,
            voiceFirstSoundMs: event.voiceFirstSoundMs,
            interrupted: event.interrupted,
          });
          break;
      }
    }
    return { ok: true };
  }
}
