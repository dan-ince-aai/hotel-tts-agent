/**
 * The CALL, as a dialog — the fixed booking script every caller hears.
 *
 * This is the blind-test version of the Harborlight desk. Every caller has to
 * hear the SAME short script, so the TTS model is the only thing that varies
 * between the two calls of a session. The script is built around what a TTS gets
 * wrong: a spelled name, a date and a full street address, each read back.
 *
 * | step | what the agent does |
 * | --- | --- |
 * | 1 | greets the caller and asks if they are ready to book (the `greeting` in `agent.ts`) |
 * | 2 | asks for the full name and a letter-by-letter spelling of the last name |
 * | 3 | reads the name back, spells the last name back, asks which night |
 * | 4 | reads the night back, then asks for the street address |
 * | 5 | reads the whole address back and asks the caller to confirm |
 * | 6 | the twist: "you're one of our regulars, we have your card on file", asks how they are |
 * | 7 | the night is on the house; goodbye |
 *
 * ## One instruction, not one state per step
 *
 * An earlier version advanced one state per caller turn. That breaks on a real
 * caller: a "hello?", an "okay" or a spelling given in two breaths each commit a
 * turn and pushed the script ahead of the conversation, so read-backs came out
 * wrong (2/8 right with a scripted untidy caller). Worse for the study, a slower
 * system draws more "hello?"s, so the old script was unfair to it.
 *
 * So the whole script is ONE speaking state whose instruction is "do the next
 * step not yet done; re-ask if the caller's turn completed nothing". The model
 * tracks progress from the conversation itself, which it can see and a state
 * machine cannot (16/16 read-backs right with the same untidy caller).
 *
 * Two knobs ride on the state:
 *
 * - **`toolChoice: "none"`.** The agent is speak-only; a caller question answered
 *   by a lookup would be a different call, and a different call is a different
 *   voice test.
 * - **`temperature: 0.2`.** Reading back a spelled name, a night and an address
 *   is transcription; the model's own variety should not add slips to it.
 */

import type { AnyDialog, ToolChoice } from "@alexkroman1/aai";
import { dialog } from "@alexkroman1/aai";

/**
 * Every turn is the model SAYING one thing and nothing else. Typed
 * {@link ToolChoice} because a bare `"none"` would widen to `string`.
 */
const SPEAK_ONLY: ToolChoice = "none";

/** Steady sampling for every turn — see the module comment. */
export const SCRIPT_TEMPERATURE = 0.2;

/** The seven steps, as the model is told them. Step 1 is the greeting. */
export const SCRIPT_STEPS = [
  "Greet the caller and ask if they are ready to book a room. (Already done by the greeting.)",
  "Ask for their full name, and in the same turn ask them to spell their last name letter by letter.",
  "Read their full name back, spell their last name back letter by letter exactly as they spelled it, then ask which night they would like to stay.",
  "Read the night back exactly as they said it, then ask for their full street address.",
  "Read the whole address back - number, street, unit, city, state and ZIP - and ask them to confirm it is correct.",
  "The twist: say you recognise them - they are one of your regulars and you already have their card on file, so no payment is needed - then ask, by first name, how they are doing today. Take no payment and ask for no card.",
  "Tell them the night is on the house, completely free, that you look forward to seeing them, and say goodbye. The call is then over.",
] as const;

export const SCRIPT_INSTRUCTION =
  "You are running a fixed seven-step booking script:\n" +
  SCRIPT_STEPS.map((step, i) => `${i + 1}. ${step}`).join("\n") +
  "\n\nOn every turn, do the NEXT step not yet done, and only that step. Work out where you are " +
  "from the conversation so far. If the caller's last turn did not complete the current step - " +
  "they said hello, okay, asked you to repeat, or gave only part of what you asked for (for " +
  "example half a spelling) - do not move on: briefly re-ask for what is still missing. If they " +
  "correct something, read the corrected value back before moving on. Once step 7 is done, say " +
  "nothing more than a short goodbye if they speak again.";

const deskSpec = {
  initial: "call",
  states: {
    /**
     * The whole script, wrapped so the hang-up is declared once: a caller who
     * drops bubbles `@session.timed-out` up to here and lands on `hungUp`, so a
     * model talking to a dead line says nothing more.
     */
    call: {
      initial: "script",
      on: { "@session.timed-out": "hungUp" },
      states: {
        script: {
          toolChoice: SPEAK_ONLY,
          temperature: SCRIPT_TEMPERATURE,
          instruction: SCRIPT_INSTRUCTION,
        },
      },
    },
    hungUp: {
      final: true,
      instruction:
        "The caller is gone. Do nothing further on this call - no more questions, no goodbye.",
    },
  },
} as const;

/**
 * The call's position, on its own slot. Persisted with the session, so a
 * reconnect resumes rather than restarts.
 */
export const deskFlow = dialog("desk", deskSpec);

/**
 * What `agent({ dialogs })` is handed — the line that wires
 * `@session.timed-out` to the dialog.
 */
export const DIALOGS: readonly AnyDialog[] = [deskFlow];
