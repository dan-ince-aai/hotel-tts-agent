import { agent } from "@alexkroman1/aai";
import { DIALOGS, SCRIPT_TEMPERATURE } from "./desk.ts";
import systemPrompt from "./system-prompt.md?raw";
import { SYSTEMS, type System, VOICE_NAMES, type VoiceName } from "./study/design.ts";
import { resolveCell, ttsForCell, type VoiceCell } from "./voices.ts";

/**
 * The Harborlight front desk, on the phone — but for the voice-preference study,
 * not as the open-ended receptionist the template ships. This agent walks every
 * caller through ONE fixed booking script (`desk.ts`), so that sixteen copies of
 * it — four cloned voices in each of four TTS systems — are all judged on the
 * same words. The server (`server.ts`) builds those copies; this file is the one
 * agent they share.
 *
 * The call never books anything and never takes a card: the script's closing
 * twist ("you're a regular, it's on us") is exactly what lets it exercise the
 * voice on a name, a night and an address — the hard material for a TTS — and
 * then end without any payment. There are no tools at all: the whole call is the
 * dialog's speak-only turns, so the simplified agent only ever runs the script.
 */
export default agent({
  name: "The Harborlight Hotel",
  description:
    "Walks every caller through one fixed hotel-booking script, for the voice-preference study",
  // Open-weight model on the AssemblyAI LLM Gateway. The previous default
  // (`qwen3.5-4b-32k-fast`) rejects requests that carry tools/tool_choice, which
  // the runtime always sends; this Gemma row supports tool calling, so the stage
  // no longer 400s mid-call.
  llm: "gemma-4-31b",
  /**
   * Wires `@user-transcript.committed` and `@session.timed-out` to the script.
   * `@user-transcript.committed` is the hinge every step turns on — without it
   * the fixed flow could never advance from one turn to the next — and
   * `@session.timed-out` is the hang-up that lands the call on `hungUp`.
   */
  dialogs: DIALOGS,
  systemPrompt,
  // Held constant for every system under test (see the protocol, "Held
  // constant"). The script state also pins this; setting it here covers the
  // greeting-adjacent turns too.
  temperature: SCRIPT_TEMPERATURE,
  // Dead-air filler OFF: when the LLM stalls, every system gets the same
  // silence. A filler would be spoken by the system under test, so a stall would
  // become extra speech for one model and not another.
  deadAirCoverMs: 0,
  // An "okay" must not cut a read-back short. Two words is the SDK default;
  // pinned here because the study depends on it.
  minBargeInWords: 2,
  // Declared so a deploy fails fast if the key the LLM/STT/TTS stages read is
  // missing, rather than mid-call. Provider rows add their own keys in voices.ts.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
  greeting:
    "Hello, thanks for calling the Harborlight Hotel. Are you ready to book a room with us?",
  /**
   * The voice `aai dev` speaks with. The study server replaces this with one
   * engine per voice cell; here `DEV_CELL` (`system:voice`, default `ours:jane`)
   * picks one, falling back to the provider's stock voice while the clones are
   * still to be made.
   */
  tts: ttsForCell(devCell()),
});

/**
 * The cell `aai dev` speaks with: `DEV_CELL` if it names one, else `ours:jane`.
 * An unknown cell is a mistake worth a loud failure rather than a silent
 * fall-through to a voice you did not pick.
 */
export function devCell(): VoiceCell {
  const spec = process.env.DEV_CELL ?? "ours:jane";
  const [system, voice] = spec.split(":");
  if (!SYSTEMS.includes(system as System) || !VOICE_NAMES.includes(voice as VoiceName)) {
    throw new Error(
      `DEV_CELL=${spec} is not a voice cell; expected <system>:<voice> with system one of ` +
        `${SYSTEMS.join(", ")} and voice one of ${VOICE_NAMES.join(", ")}.`,
    );
  }
  return resolveCell(system as System, voice as VoiceName, { allowMissing: true });
}
