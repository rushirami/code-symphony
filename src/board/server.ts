import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { Logger } from "pino";
import { createTaskStore, type TaskStore } from "../db/store.js";

export interface BoardServerOptions {
  port: number;
  dbPath: string;
  actor: string;
  identifierPrefix?: string;
  webDist?: string;
  log: Logger;
}

export interface BoardServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port: number;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MAX_BODY_BYTES = 1_000_000;

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "Request body must be a JSON object"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Known store validation messages map to client errors; anything else is an
// unexpected failure and must surface as a 500 (logged by the caller).
const NOT_FOUND_PREFIX = "No task with identifier";
const VALIDATION_PREFIXES = ["Unknown state", "Priority must be"];

export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof Error) {
    if (err.message.startsWith(NOT_FOUND_PREFIX)) return new HttpError(404, err.message);
    if (VALIDATION_PREFIXES.some((p) => err.message.startsWith(p))) return new HttpError(400, err.message);
  }
  return new HttpError(500, "Internal error");
}

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `"${key}" must be a string`);
  return v;
}

function optNumber(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number") throw new HttpError(400, `"${key}" must be a number`);
  return v;
}

function optStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new HttpError(400, `"${key}" must be an array of strings`);
  }
  return v as string[];
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function createBoardServer(opts: BoardServerOptions): BoardServer {
  const { dbPath, actor, identifierPrefix, log } = opts;
  let server: Server;
  let store: TaskStore;
  let actualPort = 0;
  const sseClients = new Set<ServerResponse>();
  let watcher: FSWatcher | undefined;
  let broadcastTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;

  function scheduleBroadcast(): void {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      for (const client of sseClients) client.write("event: changed\ndata: {}\n\n");
    }, 100);
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":ok\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    res.on("error", () => sseClients.delete(res));
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    segments: string[],
  ): Promise<void> {
    const [, resource, identifier, sub] = segments;
    const method = req.method ?? "GET";
    if (resource === "events" && method === "GET") {
      handleEvents(req, res);
      return;
    }
    if (resource !== "tasks") throw new HttpError(404, "Not found");

    if (!identifier) {
      if (method === "GET") {
        const states = url.searchParams.getAll("state");
        const labels = url.searchParams.getAll("label");
        sendJson(res, 200, store.listTasks({
          states: states.length ? states : undefined,
          labels: labels.length ? labels : undefined,
        }));
        return;
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        const title = optString(body, "title");
        if (!title?.trim()) throw new HttpError(400, '"title" is required');
        const task = store.createTask({
          title: title.trim(),
          description: optString(body, "description") ?? null,
          state: optString(body, "state"),
          priority: optNumber(body, "priority"),
          labels: optStringArray(body, "labels"),
          actor,
        });
        sendJson(res, 201, task);
        return;
      }
      throw new HttpError(405, "Method not allowed");
    }

    if (!sub) {
      if (method === "GET") {
        const task = store.getTask(identifier);
        if (!task) throw new HttpError(404, `No task with identifier "${identifier}"`);
        sendJson(res, 200, {
          task,
          comments: store.getComments(identifier),
          history: store.getHistory(identifier),
        });
        return;
      }
      if (method === "PATCH") {
        const body = await readJsonBody(req);
        const task = store.editTask(identifier, {
          title: optString(body, "title"),
          description: optString(body, "description"),
          priority: optNumber(body, "priority"),
        }, actor);
        sendJson(res, 200, task);
        return;
      }
      throw new HttpError(405, "Method not allowed");
    }

    const subId = segments[4];

    if (sub === "state" && method === "PUT") {
      const body = await readJsonBody(req);
      const state = optString(body, "state");
      if (!state) throw new HttpError(400, '"state" is required');
      sendJson(res, 200, store.updateState(identifier, state, actor));
      return;
    }

    if (sub === "comments" && method === "POST") {
      const body = await readJsonBody(req);
      const commentBody = optString(body, "body");
      if (!commentBody?.trim()) throw new HttpError(400, '"body" is required');
      sendJson(res, 201, store.addComment(identifier, actor, commentBody));
      return;
    }

    if (sub === "labels" && subId) {
      if (method === "PUT") {
        store.addLabel(identifier, subId, actor);
        res.writeHead(204).end();
        return;
      }
      if (method === "DELETE") {
        store.removeLabel(identifier, subId, actor);
        res.writeHead(204).end();
        return;
      }
    }

    if (sub === "blockers" && subId) {
      if (method === "PUT") {
        store.addBlocker(identifier, subId, actor);
        res.writeHead(204).end();
        return;
      }
      if (method === "DELETE") {
        store.removeBlocker(identifier, subId, actor);
        res.writeHead(204).end();
        return;
      }
    }

    throw new HttpError(404, "Not found");
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, rawPathname: string): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const webDist = opts.webDist;
    if (!webDist || !existsSync(path.join(webDist, "index.html"))) {
      sendJson(res, 404, { error: "Board UI not built. Run: npm --prefix web run build" });
      return;
    }
    const root = path.resolve(webDist);
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPathname);
    } catch {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    let filePath = path.resolve(root, "." + decoded);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // Only fall back to the SPA shell for route-like paths (no file
      // extension in the last segment). A request for a missing asset
      // (e.g. "/secret.txt", "/assets/missing.js") should 404, not
      // silently return index.html.
      if (path.extname(decoded) !== "") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      filePath = path.join(root, "index.html"); // SPA fallback for client routes
    }
    const stream = createReadStream(filePath);
    stream.once("error", (err) => {
      log.error({ err, filePath }, "Static file stream error");
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
      else res.destroy();
    });
    stream.once("open", () => {
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
      stream.pipe(res);
    });
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${actualPort || 1}`);
    try {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        await handleApi(req, res, url, segments);
        if ((req.method ?? "GET") !== "GET" && res.statusCode < 400) scheduleBroadcast();
        return;
      }
      // Use the raw request path, not `url.pathname`: WHATWG URL parsing
      // collapses encoded dot-segments (e.g. "%2e%2e") before serveStatic
      // ever sees them, which would silently defeat the traversal check.
      const rawPathname = (req.url ?? "/").split(/[?#]/, 1)[0] ?? "/";
      serveStatic(req, res, rawPathname);
    } catch (err) {
      const httpErr = toHttpError(err);
      if (httpErr.status >= 500) log.error({ err }, "Board API error");
      if (!res.headersSent) sendJson(res, httpErr.status, { error: httpErr.message });
      else res.end();
    }
  }

  return {
    get port() {
      return actualPort;
    },

    async start() {
      store = createTaskStore(dbPath, { identifierPrefix });
      watcher = chokidar.watch([dbPath, `${dbPath}-wal`], { ignoreInitial: true });
      watcher.on("all", () => scheduleBroadcast());
      heartbeatTimer = setInterval(() => {
        for (const client of sseClients) client.write(":ping\n\n");
      }, 30_000);
      server = createServer((req, res) => {
        void handler(req, res);
      });
      return new Promise<void>((resolve, reject) => {
        server.on("error", reject);
        server.listen(opts.port, () => {
          const addr = server.address();
          actualPort = typeof addr === "object" && addr ? addr.port : opts.port;
          log.info({ port: actualPort, dbPath }, "Board server listening");
          resolve();
        });
      });
    },

    async stop() {
      if (broadcastTimer) clearTimeout(broadcastTimer);
      broadcastTimer = undefined;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      await watcher?.close();
      for (const client of sseClients) client.end();
      sseClients.clear();
      store?.close();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
