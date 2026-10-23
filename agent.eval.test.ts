/** The def a DEPLOYED agent runs: authored, plus what `tools/` and the prompt add. */
import agentDef from "virtual:aai/agent";
// An EVAL for the voice-study desk: does the MODEL stay on the fixed booking
// script?
//
// `agent.test.ts` drives the dialog directly — it proves the script is one
// speak-only instruction that a caller turn cannot push ahead. What no direct test can
// settle is whether the live model, handed a real caller, actually walks the
// script to the end and reads each detail back. That is what this file is for.
// The agent has no tools, so "stayed on the script" is simply "called nothing".
//
// Run it with `aai eval`. Without a provider key every case runs against a
// SCRIPTED model (its `stubReply`), which still boots this agent and still
// applies the dialog's speak-only gate — so a stub run proves the wiring and
// proves nothing about what the agent chose.
import {
  describeToolCalls,
  toolCallsInTurns,
  toolNames,
} from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";

describeEval(agentDef, (test) => {
  test(
    "the desk walks the fixed booking script and never reaches for a tool",
    async ({ session }) => {
      // A whole call, caller turn by caller turn: ready, the name spelled, the
      // night, the address, the confirmation, and how they are. The script reads
      // each thing back and ends with the "you're a regular, it's on us" turn —
      // all of it SPEECH, so the claim is simply that no tool was ever called.
      const turns = await session.sayAll([
        "Yes, I'm ready to book.",
        "It's Jane Smith — S, M, I, T, H.",
        "This Friday night, please.",
        "Twelve Harbor Road, Portland.",
        "Yes, that's exactly right.",
        "I'm doing really well, thanks for asking.",
      ]);
      const calls = toolCallsInTurns(turns);

      // The pinned script is speak-only at every step, so a call that stayed on
      // it touched no tool at all.
      expect(toolNames(calls), describeToolCalls(calls)).toEqual([]);
      // And it ran to the end — the goodbye turn completed.
      expect(turns.at(-1)?.completed).toBe(true);
    },
    {
      stubReply: [
        "Wonderful - may I have your name, and could you spell your last name for me?",
        "Thank you, Jane Smith - that's S, M, I, T, H. Which night would you like to stay?",
        "Friday night, lovely. I'll take payment now - first, what's your address?",
        "Twelve Harbor Road, Portland - have I got that right?",
        "Oh - you're Jane Smith from Portland! We know you - you're one of our regulars, and we " +
          "already have your card on file. How are you doing today, Jane?",
        "Wonderful to hear. This night is on us, completely free, and we look forward to seeing " +
          "you on Friday. Take care - goodbye!",
      ],
    },
  );

  test(
    "an untidy caller does not push the script ahead of the conversation",
    async ({ session }) => {
      // The protocol's messy caller: a "hello?" while the agent is slow, an
      // "okay" mid-step, and a spelling given in two breaths. Each commits a turn
      // that completes nothing, so the read-backs must still come out right.
      const turns = await session.sayAll([
        "Hello?",
        "Yes, ready.",
        "Jennifer Thompson. T, H, O, M...",
        "...P, S, O, N.",
        "Okay.",
        "Sunday, March twenty-first.",
        "1847 Maple Ridge Drive, apartment 4B, Columbus, Ohio, 43215.",
        "Yes.",
        "Great, thanks.",
      ]);
      const said = turns.map((turn) => turn.text).join("\n");

      expect(toolNames(toolCallsInTurns(turns))).toEqual([]);
      // The full spelling came back, not the half given in the first breath.
      expect(said).toMatch(/T-?H-?O-?M-?P-?S-?O-?N/i);
      expect(said).toMatch(/March 21/i);
      expect(said).toMatch(/1847/);
      expect(said).toMatch(/43215/);
    },
    {
      stubReply: [
        "Hi, yes, I'm here - are you ready to book a room with us?",
        "Wonderful - may I have your full name, and could you spell your last name for me?",
        "Thank you - and the rest of the spelling?",
        "Jennifer Thompson, T-H-O-M-P-S-O-N. Which night would you like to stay?",
        "Which night would you like to stay with us?",
        "Sunday, March 21st - lovely. What's your full street address?",
        "That's 1847 Maple Ridge Dr, Apt 4B, Columbus, OH 43215 - is that right?",
        "Oh, Jennifer - you're one of our regulars, and we already have your card on file. How " +
          "are you doing today?",
        "So glad to hear it. Your night is on the house, completely free - we look forward to " +
          "seeing you. Goodbye!",
      ],
    },
  );
});
