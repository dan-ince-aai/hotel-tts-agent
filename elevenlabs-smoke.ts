/**
 * Proof the ElevenLabs clones answer, speaking with the real
 * ElevenLabs service. A script rather than a spec because it spends money and
 * needs `ELEVENLABS_API_KEY` — `aai test` runs every other `*.test.ts` on every
 * run, and this should not. It is the ElevenLabs analogue of `npm run eval`.
 *
 * Run it (the key is read from the environment, or from `.env` if unset):
 *
 *   node elevenlabs-smoke.ts
 *
 * For each ElevenLabs clone in the `voices.ts` grid it opens the connector against the live
 * service, speaks one line, flushes, and counts the PCM it got back. A voice id
 * ElevenLabs does not know connects, reports ready, then stays silent — so zero
 * audio for any voice fails the run loudly, which is the whole point.
 */
import { readFileSync } from "node:fs";
import { SYSTEM_MODEL, VOICE_IDS } from "./voices.ts";
import { VOICE_NAMES } from "./study/design.ts";
import { openElevenLabs, registerElevenLabsTts } from "./elevenlabs-tts-host.ts";
import { resolveElevenLabsTtsSettings } from "./elevenlabs-tts.ts";

const SAMPLE_RATE = 16_000;
const LINE = "The Harborlight Hotel, front desk. How can I help you today?";
const TURN_TIMEOUT_MS = 20_000;

/** The key from the environment, or parsed out of `.env` as a fallback. */
function resolveApiKey(): string {
  const fromEnv = process.env.ELEVENLABS_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
      const match = /^\s*ELEVENLABS_API_KEY\s*=\s*(.*)$/.exec(line);
      if (match?.[1] !== undefined) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env — fall through to the error below
  }
  throw new Error("ELEVENLABS_API_KEY is not set (checked the environment and .env).");
}

interface VoiceResult {
  readonly label: string;
  readonly voice: string;
  readonly samples: number;
  readonly done: boolean;
  readonly error: string | undefined;
}

async function speakOnce(apiKey: string, voice: string, model: string): Promise<VoiceResult> {
  const controller = new AbortController();
  const opener = openElevenLabs({ voice, model });
  const session = await opener.open({
    sampleRate: SAMPLE_RATE,
    apiKey,
    signal: controller.signal,
  });

  let samples = 0;
  let error: string | undefined;
  const settled = new Promise<"done" | "timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), TURN_TIMEOUT_MS);
    session.on("audio", (pcm) => {
      samples += pcm.length;
    });
    session.on("done", () => {
      clearTimeout(timer);
      resolve("done");
    });
    session.on("error", (err) => {
      error = err.message;
      clearTimeout(timer);
      resolve("done");
    });
  });

  session.sendText(LINE);
  session.flush();
  const outcome = await settled;
  await session.close();
  controller.abort();

  return {
    label: "",
    voice,
    samples,
    done: outcome === "done" && error === undefined,
    error,
  };
}

async function main(): Promise<void> {
  const apiKey = resolveApiKey();

  // Prove the registration door too: the server (Phases 4/8) calls exactly this.
  const unregister = registerElevenLabsTts();
  if (typeof unregister !== "function") {
    throw new Error("registerElevenLabsTts did not return an unregister function.");
  }
  unregister();

  const rows = VOICE_NAMES.flatMap((name) =>
    VOICE_IDS[name].elevenlabs === "" ? [] : [{ label: name, voice: VOICE_IDS[name].elevenlabs }],
  );
  if (rows.length === 0) throw new Error("voices.ts has no ElevenLabs clone ids yet.");
  console.log(`Speaking one line through ${rows.length} ElevenLabs voices at ${SAMPLE_RATE} Hz…\n`);

  const results: VoiceResult[] = [];
  for (const row of rows) {
    const model = resolveElevenLabsTtsSettings({ voice: row.voice, model: SYSTEM_MODEL.elevenlabs }).model;
    process.stdout.write(`  ${row.label}  ${row.voice}  (${model})  … `);
    try {
      const result = { ...(await speakOnce(apiKey, row.voice, model)), label: row.label };
      results.push(result);
      const seconds = (result.samples / SAMPLE_RATE).toFixed(2);
      console.log(
        result.error
          ? `ERROR: ${result.error}`
          : `${result.samples} samples (~${seconds}s audio)${result.done ? "" : " [no done — timed out]"}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ label: row.label, voice: row.voice, samples: 0, done: false, error: message });
      console.log(`ERROR: ${message}`);
    }
  }

  const silent = results.filter((r) => r.samples === 0);
  console.log(
    `\n${results.length - silent.length}/${results.length} ElevenLabs voices answered with audio.`,
  );
  if (silent.length > 0) {
    console.error(`Silent voices: ${silent.map((r) => `${r.label} (${r.voice})`).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
