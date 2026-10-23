/**
 * The routing server for the voice-preference study (Phase 4 of
 * `docs/tts-preference-build-plan.md`).
 *
 * The study runs sixteen copies of the one hotel agent — the same prompt, the
 * same booking script — that differ in NOTHING but the voice cell. This server
 * builds the hotel agent once, stands up one engine per cell, and hands each
 * incoming call to the next engine in an even rotation. It remembers which voice each call
 * got (keyed by the session id, which is the call id the survey will carry) and
 * serves the page the project already builds.
 *
 * ## Why this is a file rather than `aai start`
 *
 * `aai start` serves ONE agent — one voice. The study needs one front door that
 * fans out to sixteen. There is no single-agent knob for that, so this owns the
 * boot: it loads the SAME built worker `aai start` would (`loadBuiltAgent`, the
 * `.aai/worker.mjs` artifact with its tools and prompt lowered in), then wraps
 * sixteen runtimes built from it behind one {@link SessionRuntime} facade and
 * serves that with `createRuntimeServer`. Everything below the routing — the
 * session, the pipeline, the client config, the static client — is the
 * framework's, unchanged.
 *
 * Run it after a build: `npm start` builds the worker (its `prestart`) and then
 * runs this. `PORT` and `HOST` are read the way `aai start` reads them, so the
 * Render setup in Phase 9 needs nothing new.
 *
 * ## Sixteen engines, or none
 *
 * The engines are the voice grid (`voices.ts`): four cloned voices in each of
 * four systems. ElevenLabs and Inworld are this project's own connectors, so
 * `main()` registers both before building any engine — a voice agent resolves
 * its TTS opener eagerly at `createRuntime` time. A missing clone id or an
 * engine that will not build stops the server with every failure named, rather
 * than degrading to the cells that did build.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { AgentDef } from "@alexkroman1/aai";
import {
  CLIENT_ARTIFACT_REL,
  DEFAULT_START_PORT,
  loadBuiltAgent,
} from "@alexkroman1/aai-cli/start";
import {
  type AgentRuntime,
  createRuntime,
  createRuntimeServer,
  ensureSessionStateSchema,
  type SessionRuntime,
} from "@alexkroman1/aai-runtime";
import { registerMetricsSink } from "@alexkroman1/aai-runtime/metrics";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
import { registerElevenLabsTts } from "./elevenlabs-tts-host.ts";
import { registerInworldTts } from "./inworld-tts-host.ts";
import {
  closeResultsDb,
  initResultsDb,
  recordSurvey,
  recordTurn,
  recordVisitor,
  resultsDbReady,
  SurveyBodySchema,
  surveyInput,
} from "./db.ts";
import { gridOptionsFromEnv, resolveGrid, ttsForCell, type VoiceCell } from "./voices.ts";

/** One built voice cell: the cell it speaks, and the runtime that speaks it. */
interface Engine {
  readonly cell: VoiceCell;
  readonly runtime: AgentRuntime;
}

/**
 * Which voice each call got, keyed by session id (the call id the survey will
 * carry). An in-memory map is all Phase 4 needs — "the chosen voice is recorded
 * for that call"; Phase 6 adds the `visitors` row that makes it durable. Reads
 * are what the Phase 7 `/survey` handler will attach to a saved row.
 */
const callVoice = new Map<string, string>();

/** The voice label recorded for a call, or `undefined` if we never saw it. */
export function voiceForCall(callId: string): string | undefined {
  return callVoice.get(callId);
}

/**
 * Build `ctx.env` the way a deployment does: the names `.env.example` and `.env`
 * DECLARE, each resolved from the shell first and the files second, dropping the
 * blanks. This mirrors the CLI's own `resolveServerEnv(DEPLOY_ENV_FILES)` — which
 * is not a public export — so a key set in Render's dashboard (shell) wins over a
 * local `.env`, and an agent never comes to depend on a stray `process.env` var
 * that will not exist in production.
 */
function resolveAgentEnv(cwd: string): Record<string, string> {
  const declared = readEnvFile(path.join(cwd, ".env.example"));
  const local = readEnvFile(path.join(cwd, ".env"));
  const env: Record<string, string> = {};
  for (const name of new Set([...Object.keys(declared), ...Object.keys(local)])) {
    const value = process.env[name] ?? local[name] ?? declared[name] ?? "";
    if (value !== "") env[name] = value;
  }
  return env;
}

function readEnvFile(file: string): Record<string, string | undefined> {
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
}

/** This project's built UI if it has one, else the prebuilt default client. */
function resolveClientDir(cwd: string): string {
  const built = path.join(cwd, CLIENT_ARTIFACT_REL);
  return existsSync(path.join(built, "index.html")) ? built : defaultClientDir();
}

/**
 * Stand up one engine per voice cell — sixteen. Unlike the old per-row build,
 * a cell that fails to resolve (a missing key, an unregistered provider) takes
 * the server down with every failure named: the study compares the same voice
 * across four models, so a grid with a hole in it is not the study.
 */
function buildEngines(base: AgentDef, env: Record<string, string>, cells: VoiceCell[]): Engine[] {
  const engines: Engine[] = [];
  const failures: string[] = [];
  for (const cell of cells) {
    try {
      engines.push({ cell, runtime: createRuntime({ agent: { ...base, tts: ttsForCell(cell) }, env }) });
    } catch (error) {
      failures.push(`${cell.key} (${cell.provider}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} voice engine(s) failed to build:\n  ${failures.join("\n  ")}`);
  }
  return engines;
}

/**
 * Reorder the engines so the rotation STRIPES across providers instead of
 * running through one provider's four voices before reaching the next.
 *
 * In label order the list is grouped — four AssemblyAI, then four Cartesia, then
 * four ElevenLabs — so a burst of callers (or one caller in a row) would all land
 * on the same provider before any reached the next. We want the opposite: the
 * provider should change on every step, so consecutive calls go
 * AssemblyAI → Cartesia → ElevenLabs → AssemblyAI → …, and any individual caller
 * is very likely to hear a different provider each time they call.
 *
 * This is a round-robin ZIP of the per-provider groups: take each group's first
 * voice, then each group's second, and so on. Every voice still appears exactly
 * once per full cycle, so the per-voice balance is unchanged — only the ORDER is.
 * Provider order follows first appearance in `voices.ts` (AssemblyAI, Cartesia,
 * ElevenLabs); unequal group sizes (e.g. before Phase 3, when ElevenLabs is
 * absent) just drop out of the later rounds.
 */
function interleaveByProvider(engines: Engine[]): Engine[] {
  const groups = new Map<VoiceCell["system"], Engine[]>();
  for (const engine of engines) {
    const group = groups.get(engine.cell.system) ?? [];
    group.push(engine);
    groups.set(engine.cell.system, group);
  }
  const lists = [...groups.values()];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  const ordered: Engine[] = [];
  for (let round = 0; round < longest; round++) {
    for (const list of lists) {
      const engine = list[round];
      if (engine !== undefined) ordered.push(engine);
    }
  }
  return ordered;
}

/**
 * One {@link SessionRuntime} over all the engines: a NEW call takes the next
 * engine in the rotation; a RESUME goes back to the engine that first answered
 * it, because that engine holds the session's state and its voice. The voice
 * each call got is recorded as the session's sink is created — the first moment
 * its id exists.
 */
function routingRuntime(engines: Engine[]): SessionRuntime {
  const engineForSession = new Map<string, number>();
  let next = 0;

  return {
    startSession(ws, options) {
      const resumeFrom = options?.resumeFrom;
      let index: number;
      if (resumeFrom !== undefined && engineForSession.has(resumeFrom)) {
        index = engineForSession.get(resumeFrom) as number;
      } else {
        index = next;
        next = (next + 1) % engines.length;
      }
      const engine = engines[index];
      // Invariant: `index` is always in range (rotation is mod length, and a
      // recorded resume index was in range when it was stored). The guard is for
      // the compiler's `noUncheckedIndexedAccess`.
      if (engine === undefined) return;
      engine.runtime.startSession(ws, {
        ...options,
        onSinkCreated: (sessionId, sink) => {
          engineForSession.set(sessionId, index);
          callVoice.set(sessionId, engine.cell.key);
          console.info(
            `[study] call ${sessionId} -> cell ${engine.cell.key} ` +
              `(${engine.cell.provider}:${engine.cell.voiceId ?? "stock"}, ${engine.cell.source})`,
          );
          // Save path #1: a `visitors` row at call start, carrying the voice this
          // call got. Fire-and-forget — a database hiccup must not fail the call.
          recordVisitor(sessionId, engine.cell.key).catch((error: unknown) => {
            console.error(`[study] visitor save failed for ${sessionId}:`, error);
          });
          options?.onSinkCreated?.(sessionId, sink);
        },
      });
    },
    async shutdown() {
      await Promise.all(engines.map((engine) => engine.runtime.shutdown()));
    },
    // The hotel agent declares no workflows, so these are undefined on every
    // engine; forwarding the first keeps `/workflows/*` answering a truthful 404.
    workflows: engines[0]?.runtime.workflows,
    sessionEvents: engines[0]?.runtime.sessionEvents,
    deliverWorkflow: engines[0]?.runtime.deliverWorkflow,
  };
}

/** Read a request's body as JSON, capped so a stray large POST can't exhaust memory. */
async function readJsonBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body === "" ? {} : JSON.parse(body);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Save path #2: `POST /survey`. The page sends `{ callId, name, q1..q4 }` (the
 * shared contract); the server fills in the hidden voice label from the call id
 * and saves a `surveys` row. Returns `true` to claim the request so the runtime
 * server leaves the response to us. Phase 7 builds the page that posts here.
 */
function handleSurvey(req: IncomingMessage, res: ServerResponse, url: string, method: string): boolean {
  if (url.split("?")[0] !== "/survey") return false;
  if (method !== "POST") {
    sendJson(res, 405, { error: "POST only" });
    return true;
  }
  readJsonBody(req)
    .then(async (raw) => {
      const parsed = SurveyBodySchema.safeParse(raw);
      if (!parsed.success) {
        sendJson(res, 400, { error: "bad survey body", detail: parsed.error.issues });
        return;
      }
      // The voice label is attached here and never reaches the page.
      const voiceLabel = voiceForCall(parsed.data.callId) ?? null;
      await recordSurvey(surveyInput(parsed.data, voiceLabel));
      sendJson(res, 200, { ok: true, saved: resultsDbReady() });
    })
    .catch((error: unknown) => {
      console.error("[study] survey save failed:", error);
      if (!res.headersSent) sendJson(res, 500, { error: "survey save failed" });
    });
  return true;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const base = await loadBuiltAgent(cwd);
  const env = resolveAgentEnv(cwd);

  // Plug in this project's own TTS connectors before building any engine. The
  // runtime resolves a voice agent's TTS opener eagerly at `createRuntime` time,
  // so each kind must be on the registry first. One registration serves every
  // engine for the process's lifetime.
  registerElevenLabsTts();
  registerInworldTts();

  // Sixteen cells or nothing: resolveGrid names every missing clone at once, and
  // buildEngines every engine that would not stand up.
  const gridOptions = gridOptionsFromEnv(env);
  const cells = resolveGrid(gridOptions);
  if (gridOptions.oursStandIn) {
    console.warn(
      `[study] REHEARSAL: "ours" is spoken by ${gridOptions.oursStandIn} (STUDY_OURS_STANDIN). ` +
        "Calls from this server are not study data.",
    );
  }
  const stock = cells.filter((cell) => cell.source === "stock");
  if (stock.length > 0) {
    console.warn(
      `[study] DEVELOPMENT: ${stock.length} cell(s) speak a stock voice, not a clone ` +
        `(STUDY_ALLOW_MISSING_VOICES): ${stock.map((cell) => cell.key).join(", ")}.`,
    );
  }
  const built = buildEngines(base, env, cells);
  // Stripe the rotation across systems so consecutive calls change system.
  const engines = interleaveByProvider(built);
  console.info(
    `[study] ${engines.length}/${cells.length} voice engines ready; rotation order: ` +
      engines.map((e) => e.cell.key).join(" -> "),
  );
  if (env.DATABASE_URL) {
    // With a URL set, the runtime picks the DURABLE Postgres session-state
    // backend, which expects `aai_session_events` / `aai_session_state` to
    // already exist. We own this database, so we apply the SDK's session-state
    // DDL here — the one boot step `aai start`'s own server does and this custom
    // server has to carry too. Without it every session dies at start with
    // `relation "aai_session_events" does not exist` (a 1011 the client reads as
    // "Session failed to start"), falling straight through to the survey. The
    // call is best-effort and idempotent: a redeploy is a no-op, and a role that
    // cannot CREATE (tables already migrated) just warns and continues.
    await ensureSessionStateSchema({ url: env.DATABASE_URL, logger: console });
  } else {
    console.warn(
      "[study] No DATABASE_URL: session state lives in THIS process's memory. " +
        "Fine for one always-on instance; behind a load balancer, keep sessions sticky.",
    );
  }

  // Open the results database and create its three tables (Phase 6). Without a URL
  // this connects nothing and every save path is a no-op, so dev still runs.
  const dbReady = await initResultsDb(env.DATABASE_URL);
  console.info(
    dbReady
      ? "[study] results database connected; visitors / surveys / turns ready"
      : "[study] no DATABASE_URL: results are NOT saved (visitors, surveys, turns dropped)",
  );

  // Save path #3: a `turns` row per reply. The metrics sink fires once when each
  // reply settles, with the session id, which is the call id the voice is keyed
  // on — so every row carries the right voice label.
  registerMetricsSink({
    record: (event, { sessionId }) => {
      recordTurn(sessionId, voiceForCall(sessionId) ?? null, event).catch(
        (error: unknown) => {
          console.error(`[study] turn save failed for ${sessionId}:`, error);
        },
      );
    },
  });

  const server = createRuntimeServer({
    runtime: routingRuntime(engines),
    name: base.name,
    greeting: base.greeting,
    clientDir: resolveClientDir(cwd),
    request: handleSurvey,
  });

  const port = Number(process.env.PORT ?? DEFAULT_START_PORT);
  const host = process.env.HOST?.trim() || undefined;
  await server.listen(port, host);
  console.info(
    `[study] ${base.name} listening on http://${host ?? "127.0.0.1"}:${server.port}`,
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      // Close the server and the database pool together; allSettled so one
      // failing does not skip the other. Exit non-zero if either rejected.
      Promise.allSettled([server.close(), closeResultsDb()]).then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            console.error(
              `[study] shutdown failed: ${
                result.reason instanceof Error ? result.reason.message : String(result.reason)
              }`,
            );
          }
        }
        process.exit(results.some((r) => r.status === "rejected") ? 1 : 0);
      });
    });
  }
}

// Only serve when run as the entry point (`npm start`, `node server.ts`), so a
// later phase can `import { voiceForCall }` without booting a second server.
if (import.meta.main) await main();
