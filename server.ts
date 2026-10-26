/**
 * The blind-test web app: the participants' page, the study API, the admin page, and the
 * private API the LiveKit agent (`agent/`) talks to.
 *
 * The voice side runs elsewhere: a LiveKit server carries the audio, and the desk agent
 * (Python, from AssemblyAI's LiveKit reference agent) answers every call with a different
 * TTS per call. This server decides WHICH call is which and never tells the browser:
 *
 * - `POST /api/calls/connect` hands the browser a LiveKit token for a fresh room with the desk
 *   agent dispatched into it, carrying only an opaque call token (`study/livekit.ts`).
 * - `GET /internal/calls/{token}` is where the agent swaps that token for the call's voice
 *   cell, and `POST /internal/calls/{token}/events` is where it reports what happened on the
 *   call (`study/agent-api.ts`). Both need `STUDY_AGENT_SECRET`.
 *
 * Also served: `/api/*` (sign-in, sessions, questionnaire: `study/api.ts`), `/admin` and its
 * data behind `STUDY_ADMIN_PASSWORD`, `/health`, and the page built by `npm run build`.
 *
 *     npm run build && npm start
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { parseEnv } from "node:util";
import { adminSummary } from "./study/admin.ts";
import { AgentApi } from "./study/agent-api.ts";
import { ApiError, StudyApi } from "./study/api.ts";
import { CALL_COLUMNS, callRows, SESSION_COLUMNS, sessionRows, toCsv } from "./study/export.ts";
import { callAccess, type LiveKitConfig, liveKitConfigFromEnv } from "./study/livekit.ts";
import { MemoryStore, PostgresStore, type StudyStore } from "./study/store.ts";
import { gridOptionsFromEnv, resolveGrid } from "./voices.ts";

/** Where `npm run build` puts the page. */
const CLIENT_DIR = path.join(import.meta.dirname, "dist", "client");

/**
 * Build the env the way a deployment does: the names `.env.example` and `.env` DECLARE, each
 * resolved from the shell first and the files second, dropping the blanks — so a value set in
 * Render's dashboard wins over a local `.env`.
 */
function resolveEnv(cwd: string): Record<string, string> {
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

/** Read a request's body as JSON, capped so a stray large POST can't exhaust memory. */
async function readJsonBody(req: IncomingMessage, limitBytes = 256 * 1024): Promise<unknown> {
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

/** Answer with the handler's result, an ApiError's status, or a logged 500. */
function respond(res: ServerResponse, what: string, work: Promise<unknown>): void {
  work
    .then((payload) => sendJson(res, 200, payload))
    .catch((error: unknown) => {
      if (error instanceof ApiError) return sendJson(res, error.status, { error: error.message });
      console.error(`[study] ${what} failed:`, error);
      if (!res.headersSent) sendJson(res, 500, { error: "server error" });
    });
}

/** Constant-time comparison, so a secret cannot be recovered by timing. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string | undefined {
  return /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
}

/** A failed admin or agent sign-in waits this long, so guessing the secret is slow. */
const FAILED_AUTH_DELAY_MS = 750;

function refuse(res: ServerResponse, message: string): void {
  setTimeout(() => sendJson(res, 401, { error: message }), FAILED_AUTH_DELAY_MS);
}

// ---------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------

/**
 * The page's headers. `connect-src` admits any https/wss origin because the LiveKit server
 * the call connects to is configured at deploy time, not known here.
 */
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' https: wss:; img-src 'self' data:; media-src 'self' blob: data:; " +
    "worker-src 'self' blob:; object-src 'none'; base-uri 'self'",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
};

/** `/` and `/admin` are the page; `/assets/*` its hashed, immutable files. */
function handleStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (pathname === "/admin/") {
    res.writeHead(301, { location: "/admin" });
    res.end();
    return true;
  }
  if (pathname === "/" || pathname === "/admin") {
    const page = path.join(CLIENT_DIR, "index.html");
    if (!existsSync(page)) {
      sendJson(res, 503, { error: "the page isn't built: run `npm run build`" });
      return true;
    }
    res.writeHead(200, PAGE_HEADERS);
    res.end(req.method === "HEAD" ? undefined : readFileSync(page));
    return true;
  }
  if (!pathname.startsWith("/assets/")) return false;
  const file = path.normalize(path.join(CLIENT_DIR, pathname));
  if (!file.startsWith(path.join(CLIENT_DIR, "assets") + path.sep)) return false;
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : readFileSync(file));
  return true;
}

// ---------------------------------------------------------------------------
// The study API (participants).
// ---------------------------------------------------------------------------

function handleStudy(
  api: StudyApi,
  liveKit: LiveKitConfig | undefined,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean {
  const routes: Record<string, (body: unknown) => Promise<unknown>> = {
    "/api/signin": (body) => api.signIn(body),
    "/api/progress": (body) => api.progressFor(body),
    "/api/sessions": (body) => api.startSession(body),
    "/api/sessions/close": (body) => api.closeSession(body),
    "/api/calls/event": (body) => api.callEvent(body),
    "/api/responses": (body) => api.submitResponse(body),
    "/api/calls/connect": async (body) => {
      if (!liveKit) throw new ApiError(503, "calls aren't set up: LIVEKIT_URL, _API_KEY and _API_SECRET");
      const { participant, call } = await api.openCall(body);
      return callAccess(liveKit, String(participant.number), call.token);
    },
  };
  return (req, res, pathname) => {
    const route = routes[pathname];
    if (route === undefined) return false;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "POST only" });
      return true;
    }
    respond(res, pathname, readJsonBody(req).then(route));
    return true;
  };
}

// ---------------------------------------------------------------------------
// The admin.
// ---------------------------------------------------------------------------

/**
 * `GET /api/admin/summary`, `GET`/`POST /api/admin/matching` and `/api/admin/voices`, and the
 * CSV exports, behind
 * `STUDY_ADMIN_PASSWORD` or the generated `STUDY_ADMIN_TOKEN` (Bearer, or `?token=` for the
 * exports). `?all=1` includes rehearsal and smoke-test rows. With neither secret set, off.
 */
function handleAdmin(
  store: StudyStore,
  api: StudyApi,
  secrets: string[],
): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  return (req, res, url) => {
    const route = {
      "/api/admin/summary": "summary",
      "/api/admin/matching": "matching",
      "/api/admin/voices": "voices",
      "/api/export/sessions.csv": "sessions",
      "/api/export/calls.csv": "calls",
    }[url.pathname];
    if (route === undefined) return false;
    if (secrets.length === 0) {
      sendJson(res, 404, { error: "the admin is off: set STUDY_ADMIN_PASSWORD on the server" });
      return true;
    }
    const presented = bearer(req) ?? url.searchParams.get("token") ?? "";
    if (!secrets.some((secret) => tokenMatches(presented, secret))) {
      refuse(res, "wrong password");
      return true;
    }
    if (route === "voices") {
      if (req.method === "POST") {
        respond(
          res,
          "saving voices",
          readJsonBody(req)
            .then((body) => api.setVoices(body))
            .then((view) => {
              const on = view.voices.filter((v) => v.enabled).map((v) => v.slug);
              console.info(`[study] enabled voices set to ${on.join(", ")}`);
              return view;
            }),
        );
      } else {
        respond(res, "reading voices", api.voices());
      }
      return true;
    }
    if (route === "matching") {
      if (req.method === "POST") {
        respond(
          res,
          "saving matching weights",
          readJsonBody(req)
            .then((body) => api.setMatching(body))
            .then((view) => {
              console.info(`[study] matching weights set to ${JSON.stringify(view.weights)}`);
              return view;
            }),
        );
      } else {
        respond(res, "reading matching weights", api.matching());
      }
      return true;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "GET only" });
      return true;
    }
    const includeAll = url.searchParams.get("all") === "1";
    if (route === "summary") {
      respond(res, "admin summary", store.dump().then((dump) => adminSummary(dump, { includeAll })));
      return true;
    }
    store
      .dump()
      .then((dump) => {
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
        console.error(`[study] export ${route} failed:`, error);
        if (!res.headersSent) sendJson(res, 500, { error: "export failed" });
      });
    return true;
  };
}

// ---------------------------------------------------------------------------
// The agent's private API.
// ---------------------------------------------------------------------------

const INTERNAL_CALL = /^\/internal\/calls\/([0-9a-f-]{36})(\/events)?$/;

function handleAgent(
  agentApi: AgentApi,
  secret: string | undefined,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean {
  return (req, res, pathname) => {
    if (!pathname.startsWith("/internal/")) return false;
    if (!secret) {
      sendJson(res, 404, { error: "the agent API is off: set STUDY_AGENT_SECRET" });
      return true;
    }
    if (!tokenMatches(bearer(req) ?? "", secret)) {
      refuse(res, "unauthorized");
      return true;
    }
    const match = INTERNAL_CALL.exec(pathname);
    if (!match?.[1]) {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    const token = match[1];
    if (match[2] === "/events") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" }), true;
      respond(res, `events for ${token}`, readJsonBody(req).then((body) => agentApi.record(token, body)));
    } else {
      if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" }), true;
      respond(res, `cell for ${token}`, agentApi.cell(token));
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

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
  const env = resolveEnv(process.cwd());

  // Every cell or nothing: resolveGrid names every missing voice id at once.
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
  console.info(`[study] ${cells.length} voice cells ready`);

  const liveKit = liveKitConfigFromEnv(env);
  if (!liveKit) console.warn("[study] calls are off: set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET");
  if (!env.STUDY_AGENT_SECRET) console.warn("[study] the agent API is off: set STUDY_AGENT_SECRET");
  const adminSecrets = [env.STUDY_ADMIN_PASSWORD, env.STUDY_ADMIN_TOKEN].filter((s): s is string => Boolean(s));
  if (adminSecrets.length === 0) console.warn("[study] admin page is off: set STUDY_ADMIN_PASSWORD to turn it on");

  const store = await openStore(env.DATABASE_URL);
  const api = new StudyApi({ store, grid: gridOptions, studySeed: env.STUDY_SEED ?? "harborlight" });
  const study = handleStudy(api, liveKit);
  const admin = handleAdmin(store, api, adminSecrets);
  const agent = handleAgent(new AgentApi(store), env.STUDY_AGENT_SECRET);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return sendJson(res, 200, { status: "ok" });
    if (agent(req, res, url.pathname)) return;
    if (admin(req, res, url)) return;
    if (study(req, res, url.pathname)) return;
    if (handleStatic(req, res, url.pathname)) return;
    sendJson(res, 404, { error: "not found" });
  });

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST?.trim() || "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.info(`[study] listening on http://${host}:${port}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close();
      store.close().finally(() => process.exit(0));
    });
  }
}

// Only serve when run as the entry point (`npm start`, `node server.ts`).
if (import.meta.main) await main();
