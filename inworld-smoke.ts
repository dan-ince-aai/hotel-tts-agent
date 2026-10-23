/**
 * Live proof: the Inworld voices answer, speaking with the real Inworld
 * service. A script rather than a spec because it spends money and needs
 * `INWORLD_API_KEY` — `aai test` runs every other `*.test.ts` on every run, and
 * this should not. It is the Inworld analogue of `elevenlabs-smoke.ts`.
 *
 * Run it (the key is read from the environment, or from `.env` if unset):
 *
 *   node inworld-smoke.ts                 # every `inworld` row in voices.ts
 *   node inworld-smoke.ts Ashley Dennis   # or the voice ids named here
 *
 * For each voice it opens the connector against the live service, streams one
 * reply in model-sized pieces (so the per-sentence flushes run), flushes, and
 * counts the PCM it got back. Until `voices.ts` carries `inworld` rows, and with
 * no ids named, it speaks the descriptor's default voice. An unknown voice id
 * should come back as an error frame — but zero audio for any voice fails the
 * run loudly either way, which is the whole point.
 */
import { readFileSync } from "node:fs";
import { VOICES } from "./voices.ts";
import { openInworld, registerInworldTts } from "./inworld-tts-host.ts";
import { INWORLD_TTS_KIND, resolveInworldTtsSettings } from "./inworld-tts.ts";

const SAMPLE_RATE = 24_000;
const LINE = "The Harborlight Hotel, front desk. How can I help you today?";
const TURN_TIMEOUT_MS = 20_000;

/** The key from the environment, or parsed out of `.env` as a fallback. */
function resolveApiKey(): string {
  const fromEnv = process.env.INWORLD_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
      const match = /^\s*INWORLD_API_KEY\s*=\s*(.*)$/.exec(line);
      if (match?.[1] !== undefined) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env — fall through to the error below
  }
  throw new Error("INWORLD_API_KEY is not set (checked the environment and .env).");
}

interface VoiceResult {
  readonly label: string;
  readonly voice: string;
  readonly samples: number;
  readonly firstAudioMs: number | undefined;
  readonly done: boolean;
  readonly error: string | undefined;
}

async function speakOnce(apiKey: string, label: string, voice: string): Promise<VoiceResult> {
  const controller = new AbortController();
  const opener = openInworld({ voice });
  const session = await opener.open({
    sampleRate: SAMPLE_RATE,
    apiKey,
    signal: controller.signal,
  });

  let samples = 0;
  let firstAudioMs: number | undefined;
  let error: string | undefined;
  const started = performance.now();
  const settled = new Promise<"done" | "timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), TURN_TIMEOUT_MS);
    session.on("audio", (pcm) => {
      firstAudioMs ??= performance.now() - started;
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

  // Word-sized deltas, as an LLM streams them, so the sentence splitter runs.
  for (const piece of LINE.match(/\S+\s*/g) ?? [LINE]) session.sendText(piece);
  session.flush();
  const outcome = await settled;
  await session.close();
  controller.abort();

  return { label, voice, samples, firstAudioMs, done: outcome === "done" && !error, error };
}

async function main(): Promise<void> {
  const apiKey = resolveApiKey();

  // Prove the registration door too: the server calls exactly this.
  const unregister = registerInworldTts();
  if (typeof unregister !== "function") {
    throw new Error("registerInworldTts did not return an unregister function.");
  }
  unregister();

  // `provider` is widened so this compiles before `voices.ts` gains the kind.
  const fromRows = VOICES.filter((row) => (row.provider as string) === INWORLD_TTS_KIND).map(
    (row) => ({ label: row.label, voice: row.voice }),
  );
  const named = process.argv.slice(2).map((voice) => ({ label: "cli", voice }));
  const fallback = [{ label: "default", voice: resolveInworldTtsSettings({}).voice }];
  const targets = named.length > 0 ? named : fromRows.length > 0 ? fromRows : fallback;

  console.log(`Speaking one line through ${targets.length} Inworld voices at ${SAMPLE_RATE} Hz…\n`);

  const results: VoiceResult[] = [];
  for (const { label, voice } of targets) {
    const model = resolveInworldTtsSettings({ voice }).model;
    process.stdout.write(`  ${label}  ${voice}  (${model})  … `);
    try {
      const result = await speakOnce(apiKey, label, voice);
      results.push(result);
      const seconds = (result.samples / SAMPLE_RATE).toFixed(2);
      const ttfa = result.firstAudioMs === undefined ? "" : `, first audio ${result.firstAudioMs.toFixed(0)} ms`;
      console.log(
        result.error
          ? `ERROR: ${result.error}`
          : `${result.samples} samples (~${seconds}s audio${ttfa})${result.done ? "" : " [no done — timed out]"}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ label, voice, samples: 0, firstAudioMs: undefined, done: false, error: message });
      console.log(`ERROR: ${message}`);
    }
  }

  const silent = results.filter((r) => r.samples === 0);
  console.log(`\n${results.length - silent.length}/${results.length} Inworld voices answered with audio.`);
  if (silent.length > 0) {
    console.error(`Silent voices: ${silent.map((r) => `${r.label} (${r.voice})`).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
