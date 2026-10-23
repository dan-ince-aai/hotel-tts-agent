/** The def a DEPLOYED agent runs: authored, plus what the prompt adds. */
import agentDef from "virtual:aai/agent";
import type { SessionEvent, ToolContext } from "@alexkroman1/aai";
import { createToolContext } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import { deskFlow, SCRIPT_INSTRUCTION, SCRIPT_STEPS, SCRIPT_TEMPERATURE } from "./desk.ts";

// The blind-test agent: no tools, no booking state machine, no hotel domain.
// Its whole behaviour is the fixed seven-step booking script in `desk.ts`, run as
// ONE speak-only instruction the model follows from the conversation. So these
// specs cover the deployed agent's shape, the held-constant voice knobs, and
// that the script state stays put on caller turns and ends on a hang-up.

// ─── Harness ─────────────────────────────────────────────────────────────────

/** What the runtime offers the desk dialog when the caller says something. */
const HEARD_SOMETHING: SessionEvent = {
  type: "user-transcript.committed",
  text: "yes, that's right",
  meta: { id: "evt_1", at: 0 },
};

/** And when they hang up (or the idle watchdog fires). */
const CALLER_GONE: SessionEvent = { type: "session.timed-out", meta: { id: "evt_2", at: 0 } };

/** Where the call is, without going through a tool. */
const at = (ctx: ToolContext) => deskFlow.position(ctx).state;

/** The caller answers — their next committed turn is what advances the script. */
const callerAnswers = (ctx: ToolContext) => deskFlow.receive(ctx, HEARD_SOMETHING).state;

// ─── The deployed agent's shape ──────────────────────────────────────────────

describe("the deployed agent", () => {
  test("is the Harborlight desk, opening on the booking question", () => {
    expect(agentDef.name).toBe("The Harborlight Hotel");
    expect(agentDef.greeting).toMatch(/book a room/i);
  });

  test("carries no tools — the whole call is the script, never a tool call", () => {
    expect(Object.keys(agentDef.tools)).toEqual([]);
  });

  test("runs exactly one dialog: the fixed booking script", () => {
    expect(agentDef.dialogs).toHaveLength(1);
    expect(agentDef.dialogs?.[0]).toBe(deskFlow);
  });
});

// ─── Held constant across every system ───────────────────────────────────────

describe("the voice knobs the protocol holds constant", () => {
  test("temperature 0.2, dead-air filler off, barge-in needs two words", () => {
    expect(agentDef.temperature).toBe(0.2);
    expect(agentDef.deadAirCoverMs).toBe(0);
    expect(agentDef.minBargeInWords).toBe(2);
  });
});

// ─── The fixed booking script ────────────────────────────────────────────────

describe("the fixed booking script", () => {
  test("a fresh call opens on the one script state, speak-only and steady", () => {
    const ctx = createToolContext();
    expect(at(ctx)).toBe("call.script");
    expect(deskFlow.voiceConfig(ctx)?.toolChoice).toBe("none");
    expect(deskFlow.voiceConfig(ctx)?.temperature).toBe(SCRIPT_TEMPERATURE);
  });

  test("the instruction lists all seven steps and the next-step-not-done rule", () => {
    expect(SCRIPT_STEPS).toHaveLength(7);
    for (const step of SCRIPT_STEPS) expect(SCRIPT_INSTRUCTION).toContain(step);
    expect(SCRIPT_INSTRUCTION).toMatch(/NEXT step not yet done/);
    expect(SCRIPT_INSTRUCTION).toMatch(/re-ask/);
  });

  test("a caller turn does not push the script ahead — the model tracks progress", () => {
    const ctx = createToolContext();
    for (let i = 0; i < 10; i++) expect(callerAnswers(ctx)).toBe("call.script");
  });

  test("a hang-up ends the call on hungUp, and nothing restarts it", () => {
    const ctx = createToolContext();
    callerAnswers(ctx);
    expect(deskFlow.receive(ctx, CALLER_GONE).state).toBe("hungUp");
    expect(callerAnswers(ctx)).toBe("hungUp");
  });
});
