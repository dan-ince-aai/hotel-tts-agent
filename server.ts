/**
 * The blind-test server: one front door over sixteen engines, and the study's
 * API.
 *
 * The study runs sixteen copies of the one hotel agent — the same prompt, the
 * same booking script — that differ in NOTHING but the voice cell (`voices.ts`:
 * four cloned voices in each of four systems). This server builds the hotel
 * agent once, stands up one engine per cell, and serves:
 *
 * - **`/api/*`** — sign-in, sessions, call events and the questionnaire
 *   (`study/api.ts`). A session is handed to the page as two opaque call tokens.
 * - **`WS /websocket?call=<token>`** — each call's audio socket. The token is
 *   looked up in the store and the socket handed to the engine for that call's
 *   cell. The browser never names a system or a voice; it only ever holds the
 *   token, so nothing on the page can say which call was ours.
 * - **`GET /admin`** — the admin page, with the data behind it
 *   (`/api/admin/summary`, `/api/export/{sessions,calls}.csv`) guarded by
 *   `STUDY_ADMIN_PASSWORD`; see {@link handleAdmin}.
 * - the page itself (`client.tsx`, built into `.aai/client`).
 *
 * ## Why this is a file rather than `aai start`
 *
 * `aai start` serves ONE agent — one voice. This loads the SAME built worker
 * `aai start` would (`loadBuiltAgent`), builds sixteen runtimes from it, and
 * claims the session upgrade itself so it can route on the call token.
 * Everything below the routing — the session, the pipeline, the static client —
 * is the framework's, unchanged.
 *
 * Run it after a build: `npm start` builds the worker (its `prestart`) and then
 * runs this. `PORT` and `HOST` are read the way `aai start` reads them.
 *
 * ## Sixteen engines, or none
 *
 * ElevenLabs and Inworld are this project's own connectors, so `main()`
 * registers both before building any engine — a voice agent resolves its TTS
 * opener eagerly at `createRuntime` time. A missing clone id or an engine that
 * will not build stops the server with every failure named.
 *
 * ## What the server records on its own
 *
 * The page reports what only it can see (the caller ended, skipped, or lost the
 * call). Everything else the setup-failure rule needs is recorded here, from the
 * runtime: a socket CONNECTED for the call (each retry is another attempt), the
 * voice SPOKE (a reply produced first audio), a FATAL error and whether it was
 * the TTS, every reply's four speed numbers, and each side's committed words
 * (the read-back check reads the agent's).
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { AgentDef } from "@alexkroman1/aai";
import { MAX_WS_PAYLOAD_BYTES } from "@alexkroman1/aai/host-internal";
import { CLIENT_ARTIFACT_REL, DEFAULT_START_PORT, loadBuiltAgent } from "@alexkroman1/aai-cli/start";
import {
  type AgentRuntime,
  createRuntime,
  createRuntimeServer,
  ensureSessionStateSchema,
  type SessionRuntime,
  type SessionWebSocket,
} from "@alexkroman1/aai-runtime";
import { registerMetricsSink } from "@alexkroman1/aai-runtime/metrics";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
import { WebSocketServer } from "ws";
import { registerElevenLabsTts } from "./elevenlabs-tts-host.ts";
import { registerInworldTts } from "./inworld-tts-host.ts";
import { ApiError, StudyApi } from "./study/api.ts";
import { adminSummary } from "./study/admin.ts";
import { CALL_COLUMNS, callRows, SESSION_COLUMNS, sessionRows, toCsv } from "./study/export.ts";
import { MemoryStore, PostgresStore, type StudyStore, turnTimings } from "./study/store.ts";
import { gridOptionsFromEnv, resolveGrid, ttsForCell, type VoiceCell } from "./voices.ts";

/** One built voice cell: the cell it speaks, and the runtime that speaks it. */
interface Engine {
  readonly cell: VoiceCell;
  readonly runtime: AgentRuntime;
}

/**
 * Which call each live runtime session belongs to. The runtime's hooks (events,
 * metrics) know only the runtime session id; this is how they find the call. The
 * store keeps the same link durably for the export.
 */
const callForRuntime = new Map<string, string>();

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

/** Log a fire-and-forget save that failed; a database hiccup must not fail a call. */
function logFailure(what: string) {
  return (error: unknown) => console.error(`[study] ${what} failed:`, error);
}

/**
 * Stand up one engine per voice cell — sixteen. A cell that fails to resolve (a
 * missing key, an unregistered provider) takes the server down with every
 * failure named: the study compares the same voice across four models, so a grid
 * with a hole in it is not the study.
 *
 * Each engine's agent carries the study's event hooks: a FATAL error is recorded
 * against the call, flagged as a TTS failure when that is what it was (the
 * analysis scores fatal TTS errors as losses in a sensitivity fit), and each
 * side's committed words are saved for the read-back check.
 */
function buildEngines(
  base: AgentDef,
  env: Record<string, string>,
  cells: VoiceCell[],
  store: StudyStore,
): Engine[] {
  const engines: Engine[] = [];
  const failures: string[] = [];
  const saveWords = (role: "agent" | "caller") => (event: { text: string }, ctx: { sessionId: string }) => {
    const token = callForRuntime.get(ctx.sessionId);
    if (token === undefined || event.text.trim() === "") return;
    store
      .recordUtterance(ctx.sessionId, { callToken: token, role, text: event.text })
      .catch(logFailure(`transcript save for ${token}`));
  };
  const events: AgentDef["events"] = {
    ...base.events,
    "agent-transcript.committed": saveWords("agent"),
    "user-transcript.committed": saveWords("caller"),
    "error.reported": (event, ctx) => {
      if (!event.fatal) return;
      const token = callForRuntime.get(ctx.sessionId);
      if (token === undefined) return;
      console.warn(`[study] call ${token} fatal ${event.code} error: ${event.message}`);
      store
        .recordCallEvent(token, { type: "fatal", code: event.code, message: event.message })
        .catch(logFailure(`fatal-error save for ${token}`));
    },
  };
  for (const cell of cells) {
    try {
      engines.push({
        cell,
        runtime: createRuntime({ agent: { ...base, tts: ttsForCell(cell), events }, env }),
      });
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
 * The browser offers subprotocols only to carry a session ticket, which this
 * server does not use; answer with the first offer that is not one (or none),
 * so the handshake never echoes a ticket back.
 */
function selectProtocol(protocols: Set<string>): string | false {
  for (const protocol of protocols) if (!protocol.startsWith("aai.auth.")) return protocol;
  return false;
}

/** Refuse an upgrade before the handshake, with a status line and nothing else. */
function refuseUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Claim every `/websocket` upgrade and route it on its `call` token. A token the
 * store does not know, or a call already finished, is refused before the
 * handshake — so an old tab cannot reopen a finished call and add a phantom
 * attempt to it.
 */
function routeCalls(engines: Map<string, Engine>, store: StudyStore) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    handleProtocols: selectProtocol,
  });
  return (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/websocket") return false;
    const token = url.searchParams.get("call") ?? "";
    store
      .call(token)
      .then((call) => {
        if (!call) return refuseUpgrade(socket, "404 Not Found");
        if (call.completed || call.skipped) return refuseUpgrade(socket, "409 Conflict");
        const engine = engines.get(call.cellKey);
        if (!engine) {
          console.error(`[study] call ${token} names cell ${call.cellKey}, which this server did not build`);
          return refuseUpgrade(socket, "503 Service Unavailable");
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          engine.runtime.startSession(ws as unknown as SessionWebSocket, {
            onSinkCreated: (runtimeId) => {
              callForRuntime.set(runtimeId, token);
              store.linkRuntimeSession(runtimeId, token).catch(logFailure(`runtime link for ${token}`));
              store.recordCallEvent(token, { type: "connected" }).catch(logFailure(`connect save for ${token}`));
              console.info(`[study] call ${token} -> ${call.cellKey} (runtime ${runtimeId})`);
            },
            onSessionEnd: (runtimeId) => {
              callForRuntime.delete(runtimeId);
            },
          });
        });
      })
      .catch((error: unknown) => {
        console.error(`[study] upgrade for call ${token} failed:`, error);
        refuseUpgrade(socket, "500 Internal Server Error");
      });
    return true;
  };
}

/**
 * The runtime the framework's server is handed. Every session upgrade is claimed
 * by {@link routeCalls} first, so this only exists to satisfy the server's shape
 * and to shut the engines down with it.
 */
function enginesRuntime(engines: Engine[]): SessionRuntime {
  return {
    startSession(ws) {
      ws.close?.(1008, "connect with a call token");
    },
    async shutdown() {
      await Promise.all(engines.map((engine) => engine.runtime.shutdown()));
    },
    // The hotel agent declares no workflows; undefined keeps `/workflows/*` a 404.
    workflows: undefined,
    sessionEvents: undefined,
    deliverWorkflow: undefined,
  };
}

/** Read a request's body as JSON, capped so a stray large POST can't exhaust memory. */
async function readJsonBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new ApiError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  try {
    return body === "" ? {} : JSON.parse(body);
  } catch {
    throw new ApiError(400, "body is not JSON");
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/** The study API's routes: POST, JSON in, JSON out. */
function apiRoutes(api: StudyApi): Record<string, (body: unknown) => Promise<unknown>> {
  return {
    "/api/signin": (body) => api.signIn(body),
    "/api/progress": (body) => api.progressFor(body),
    "/api/sessions": (body) => api.startSession(body),
    "/api/sessions/close": (body) => api.closeSession(body),
    "/api/calls/event": (body) => api.callEvent(body),
    "/api/responses": (body) => api.submitResponse(body),
  };
}

function handleApi(routes: ReturnType<typeof apiRoutes>) {
  return (req: IncomingMessage, res: ServerResponse, url: string, method: string): boolean => {
    const route = routes[url.split("?")[0] ?? ""];
    if (route === undefined) return false;
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST only" });
      return true;
    }
    readJsonBody(req)
      .then(route)
      .then((payload) => sendJson(res, 200, payload))
      .catch((error: unknown) => {
        if (error instanceof ApiError) {
          sendJson(res, error.status, { error: error.message });
          return;
        }
        console.error(`[study] ${url} failed:`, error);
        if (!res.headersSent) sendJson(res, 500, { error: "server error" });
      });
    return true;
  };
}

/** Constant-time comparison, so a secret cannot be recovered by timing. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The page's HTML is served with the same headers the framework gives `/`. */
const PAGE_HEADERS = {
  "content-type": "text/html",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' " +
    "https://fonts.googleapis.com; connect-src 'self' wss: ws:; img-src 'self' data:; " +
    "media-src 'self' blob: data:; font-src 'self' https://fonts.gstatic.com; object-src 'none'; base-uri 'self'",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

/** A failed admin sign-in waits this long, so guessing the password is slow. */
const FAILED_AUTH_DELAY_MS = 750;

/**
 * The admin surface:
 *
 * - `GET /admin` — the page (`admin.tsx`, in the same bundle as the study page;
 *   `client.tsx` picks it by path). It asks for the password and holds it only
 *   for the browser tab.
 * - `GET /api/admin/summary` — what the page shows (`study/admin.ts`).
 * - `GET`/`POST /api/admin/matching` — the competitor weights (`study/api.ts`).
 * - `GET /api/export/sessions.csv` (the analysis input) and `/api/export/calls.csv`
 *   (per call, with transcripts).
 *
 * The API routes take the secret as `Authorization: Bearer …` or `?token=…`;
 * `?all=1` includes rehearsal and smoke-test rows, marked. The secret is
 * `STUDY_ADMIN_PASSWORD` or `STUDY_ADMIN_TOKEN` — either works, so a password
 * you choose and the blueprint's generated token can coexist. With neither set,
 * the routes answer that the admin is off.
 */
function handleAdmin(store: StudyStore, api: StudyApi, secrets: string[], clientDir: string) {
  return (req: IncomingMessage, res: ServerResponse, url: string, method: string): boolean => {
    // The hook's `url` is the path; the query string is only on `req.url`.
    const parsed = new URL(req.url ?? url, "http://localhost");
    if (parsed.pathname === "/admin/") {
      res.writeHead(301, { location: "/admin" });
      res.end();
      return true;
    }
    if (parsed.pathname === "/admin") {
      const page = path.join(clientDir, "index.html");
      if (!existsSync(page)) return false;
      res.writeHead(200, PAGE_HEADERS);
      res.end(readFileSync(page));
      return true;
    }
    const route = {
      "/api/admin/summary": "summary",
      "/api/admin/matching": "matching",
      "/api/export/sessions.csv": "sessions",
      "/api/export/calls.csv": "calls",
    }[parsed.pathname];
    if (route === undefined) return false;
    if (secrets.length === 0) {
      sendJson(res, 404, { error: "the admin is off: set STUDY_ADMIN_PASSWORD on the server" });
      return true;
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const presented = bearer ?? parsed.searchParams.get("token") ?? "";
    if (!secrets.some((secret) => tokenMatches(presented, secret))) {
      setTimeout(() => sendJson(res, 401, { error: "wrong password" }), FAILED_AUTH_DELAY_MS);
      return true;
    }
    if (route === "matching" && method === "POST") {
      readJsonBody(req)
        .then((body) => api.setMatching(body))
        .then((view) => {
          console.info(`[study] matching weights set to ${JSON.stringify(view.weights)}`);
          sendJson(res, 200, view);
        })
        .catch((error: unknown) => {
          if (error instanceof ApiError) return sendJson(res, error.status, { error: error.message });
          console.error("[study] saving matching weights failed:", error);
          if (!res.headersSent) sendJson(res, 500, { error: "could not save the weights" });
        });
      return true;
    }
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET only" });
      return true;
    }
    if (route === "matching") {
      api
        .matching()
        .then((view) => sendJson(res, 200, view))
        .catch((error: unknown) => {
          console.error("[study] reading matching weights failed:", error);
          if (!res.headersSent) sendJson(res, 500, { error: "could not read the weights" });
        });
      return true;
    }
    const includeAll = parsed.searchParams.get("all") === "1";
    store
      .dump()
      .then((dump) => {
        if (route === "summary") {
          sendJson(res, 200, adminSummary(dump, { includeAll }));
          return;
        }
        const csv =
          route === "sessions"
            ? toCsv(SESSION_COLUMNS, sessionRows(dump, { includeAll }))
            : toCsv(CALL_COLUMNS, callRows(dump, { includeAll }));
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${route}.csv"`,
          "cache-control": "no-store",
        });
        res.end(csv);
      })
      .catch((error: unknown) => {
        console.error(`[study] admin ${route} failed:`, error);
        if (!res.headersSent) sendJson(res, 500, { error: "admin request failed" });
      });
    return true;
  };
}

async function openStore(databaseUrl: string | undefined): Promise<StudyStore> {
  if (databaseUrl) {
    const store = await PostgresStore.open(databaseUrl);
    console.info("[study] results database connected");
    return store;
  }
  console.warn(
    "[study] No DATABASE_URL: results live in THIS process's memory and are lost on restart. " +
      "Fine for development; set DATABASE_URL for real sessions.",
  );
  return new MemoryStore();
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const base = await loadBuiltAgent(cwd);
  const env = resolveAgentEnv(cwd);

  // Plug in this project's own TTS connectors before building any engine.
  registerElevenLabsTts();
  registerInworldTts();

  // Sixteen cells or nothing: resolveGrid names every missing clone at once, and
  // buildEngines every engine that would not stand up.
  const gridOptions = gridOptionsFromEnv(env);
  const cells = resolveGrid(gridOptions);
  if (gridOptions.oursStandIn) {
    console.warn(
      `[study] REHEARSAL: "ours" is spoken by ${gridOptions.oursStandIn} (STUDY_OURS_STANDIN). ` +
        "Sessions from this server are marked rehearsal and are not study data.",
    );
  }
  const stock = cells.filter((cell) => cell.source === "stock");
  if (stock.length > 0) {
    console.warn(
      `[study] DEVELOPMENT: ${stock.length} cell(s) speak a stock voice, not a clone ` +
        `(STUDY_ALLOW_MISSING_VOICES): ${stock.map((cell) => cell.key).join(", ")}. ` +
        "Sessions from this server are marked rehearsal.",
    );
  }

  if (env.DATABASE_URL) {
    // With a URL set, the runtime picks the DURABLE Postgres session-state
    // backend, which expects its tables to exist. We own this database, so we
    // apply the SDK's session-state DDL here — the boot step `aai start`'s own
    // server does and this custom server has to carry too. Idempotent.
    await ensureSessionStateSchema({ url: env.DATABASE_URL, logger: console });
  }
  const store = await openStore(env.DATABASE_URL);

  const built = buildEngines(base, env, cells, store);
  const engines = new Map(built.map((engine) => [engine.cell.key, engine]));
  console.info(`[study] ${engines.size}/${cells.length} voice engines ready`);

  // One row per reply, with its four speed numbers; and the first reply that
  // produced audio marks the call as having SPOKEN — a call whose voice never
  // made a sound is a setup failure, not a data point.
  registerMetricsSink({
    record: (event, { sessionId }) => {
      const token = callForRuntime.get(sessionId) ?? null;
      const timings = turnTimings(event);
      store.recordTurn(sessionId, token, timings).catch(logFailure(`turn save for ${sessionId}`));
      if (token !== null && timings.voiceFirstSoundMs !== null) {
        store.recordCallEvent(token, { type: "spoke" }).catch(logFailure(`spoke save for ${token}`));
      }
    },
  });

  const api = new StudyApi({ store, grid: gridOptions, studySeed: env.STUDY_SEED ?? "harborlight" });
  const clientDir = resolveClientDir(cwd);
  const adminSecrets = [env.STUDY_ADMIN_PASSWORD, env.STUDY_ADMIN_TOKEN].filter((s): s is string => Boolean(s));
  if (adminSecrets.length === 0) console.warn("[study] admin page is off: set STUDY_ADMIN_PASSWORD to turn it on");
  const adminRoutes = handleAdmin(store, api, adminSecrets, clientDir);
  const studyRoutes = handleApi(apiRoutes(api));
  const server = createRuntimeServer({
    runtime: enginesRuntime(built),
    name: base.name,
    greeting: base.greeting,
    clientDir,
    upgrade: routeCalls(engines, store),
    request: (req, res, url, method) =>
      adminRoutes(req, res, url, method) || studyRoutes(req, res, url, method),
  });

  const port = Number(process.env.PORT ?? DEFAULT_START_PORT);
  const host = process.env.HOST?.trim() || undefined;
  await server.listen(port, host);
  console.info(`[study] ${base.name} listening on http://${host ?? "127.0.0.1"}:${server.port}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      // Close the server and the store together; allSettled so one failing does
      // not skip the other. Exit non-zero if either rejected.
      Promise.allSettled([server.close(), store.close()]).then((results) => {
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

// Only serve when run as the entry point (`npm start`, `node server.ts`).
if (import.meta.main) await main();
