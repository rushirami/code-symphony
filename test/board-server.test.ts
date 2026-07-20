import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import pino from "pino";
import { createBoardServer, toHttpError, type BoardServer } from "../src/board/server.js";
import { createTaskStore } from "../src/db/store.js";
import { useTmpDir } from "./helpers.js";

const log = pino({ level: "silent" });

let server: BoardServer;
let url: string;
let dbPath: string;

async function startBoard(extra: { webDist?: string } = {}): Promise<void> {
  const dir = await useTmpDir();
  dbPath = path.join(dir, "tasks.db");
  server = createBoardServer({ port: 0, dbPath, actor: "rushi", identifierPrefix: "TASK", log, ...extra });
  await server.start();
  url = `http://localhost:${server.port}`;
}

afterEach(async () => {
  await server?.stop();
});

async function post(pathname: string, body: unknown, method = "POST"): Promise<Response> {
  return fetch(`${url}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("board server: read + create", () => {
  beforeEach(async () => {
    await startBoard();
  });

  it("GET /api/tasks returns [] on a fresh db", async () => {
    const res = await fetch(`${url}/api/tasks`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("POST /api/tasks creates a task and returns 201", async () => {
    const res = await post("/api/tasks", {
      title: "Fix login",
      description: "SSO broken",
      priority: 1,
      labels: ["bug"],
      state: "Todo",
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.identifier).toBe("TASK-1");
    expect(task.state).toBe("Todo");
    expect(task.priority).toBe(1);
    expect(task.labels).toEqual(["bug"]);
  });

  it("POST /api/tasks without title returns 400 with error body", async () => {
    const res = await post("/api/tasks", { description: "no title" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/title/);
  });

  it("POST /api/tasks with invalid priority returns 400", async () => {
    const res = await post("/api/tasks", { title: "x", priority: 9 });
    expect(res.status).toBe(400);
  });

  it("POST /api/tasks with malformed JSON returns 400", async () => {
    const res = await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/tasks/:identifier returns task, comments, and history", async () => {
    await post("/api/tasks", { title: "A" });
    const res = await fetch(`${url}/api/tasks/TASK-1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.identifier).toBe("TASK-1");
    expect(body.comments).toEqual([]);
    expect(body.history).toHaveLength(1);
    expect(body.history[0].kind).toBe("created");
    expect(body.history[0].actor).toBe("rushi");
  });

  it("GET /api/tasks/:identifier for unknown task returns 404", async () => {
    const res = await fetch(`${url}/api/tasks/TASK-999`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/TASK-999/);
  });

  it("GET /api/tasks?state=Todo filters by state", async () => {
    await post("/api/tasks", { title: "A", state: "Todo" });
    await post("/api/tasks", { title: "B", state: "Backlog" });
    const res = await fetch(`${url}/api/tasks?state=Todo`);
    const tasks = await res.json();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("A");
  });

  it("GET /api/unknown returns 404 JSON", async () => {
    const res = await fetch(`${url}/api/unknown`);
    expect(res.status).toBe(404);
  });

  // Fix: the server binds explicitly to 127.0.0.1 (not all interfaces), so it
  // must still be reachable over loopback. Non-loopback unreachability can't
  // be asserted portably in CI (no guaranteed non-loopback interface), so
  // this loopback-reachability check is the practical pin for that binding.
  it("is reachable via 127.0.0.1 (loopback bind)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("board server: mutations", () => {
  beforeEach(async () => {
    await startBoard();
    await post("/api/tasks", { title: "A", state: "Backlog" });
    await post("/api/tasks", { title: "B", state: "Todo" });
  });

  it("PATCH /api/tasks/:id edits title, description, priority", async () => {
    const res = await post("/api/tasks/TASK-1", { title: "A2", description: "desc", priority: 2 }, "PATCH");
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.title).toBe("A2");
    expect(task.description).toBe("desc");
    expect(task.priority).toBe(2);
  });

  it("PATCH with invalid priority returns 400", async () => {
    const res = await post("/api/tasks/TASK-1", { priority: 7 }, "PATCH");
    expect(res.status).toBe(400);
  });

  it("PUT /api/tasks/:id/state moves the task", async () => {
    const res = await post("/api/tasks/TASK-1/state", { state: "In Progress" }, "PUT");
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("In Progress");
  });

  it("PUT state with unknown state returns 400", async () => {
    const res = await post("/api/tasks/TASK-1/state", { state: "Nope" }, "PUT");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown state/);
  });

  it("PUT state on unknown task returns 404", async () => {
    const res = await post("/api/tasks/TASK-99/state", { state: "Todo" }, "PUT");
    expect(res.status).toBe(404);
  });

  it("POST /api/tasks/:id/comments adds a comment authored by the server actor", async () => {
    const res = await post("/api/tasks/TASK-1/comments", { body: "hello" });
    expect(res.status).toBe(201);
    const comment = await res.json();
    expect(comment.author).toBe("rushi");
    expect(comment.body).toBe("hello");
    const detail = await (await fetch(`${url}/api/tasks/TASK-1`)).json();
    expect(detail.comments).toHaveLength(1);
  });

  it("POST comment with empty body returns 400", async () => {
    const res = await post("/api/tasks/TASK-1/comments", { body: "" });
    expect(res.status).toBe(400);
  });

  it("PUT and DELETE label", async () => {
    const put = await fetch(`${url}/api/tasks/TASK-1/labels/bug`, { method: "PUT" });
    expect(put.status).toBe(204);
    let detail = await (await fetch(`${url}/api/tasks/TASK-1`)).json();
    expect(detail.task.labels).toEqual(["bug"]);
    const del = await fetch(`${url}/api/tasks/TASK-1/labels/bug`, { method: "DELETE" });
    expect(del.status).toBe(204);
    detail = await (await fetch(`${url}/api/tasks/TASK-1`)).json();
    expect(detail.task.labels).toEqual([]);
  });

  it("PUT and DELETE blocker", async () => {
    const put = await fetch(`${url}/api/tasks/TASK-1/blockers/TASK-2`, { method: "PUT" });
    expect(put.status).toBe(204);
    let detail = await (await fetch(`${url}/api/tasks/TASK-1`)).json();
    expect(detail.task.blockedBy.map((b: { identifier: string }) => b.identifier)).toEqual(["TASK-2"]);
    const del = await fetch(`${url}/api/tasks/TASK-1/blockers/TASK-2`, { method: "DELETE" });
    expect(del.status).toBe(204);
    detail = await (await fetch(`${url}/api/tasks/TASK-1`)).json();
    expect(detail.task.blockedBy).toEqual([]);
  });

  it("PUT blocker with unknown blocker returns 404", async () => {
    const res = await fetch(`${url}/api/tasks/TASK-1/blockers/TASK-99`, { method: "PUT" });
    expect(res.status).toBe(404);
  });
});

describe("toHttpError", () => {
  it("maps not-found store errors to 404", () => {
    expect(toHttpError(new Error('No task with identifier "TASK-9"')).status).toBe(404);
  });
  it("maps known validation messages to 400", () => {
    expect(toHttpError(new Error('Unknown state "Nope". Valid states: ...')).status).toBe(400);
    expect(toHttpError(new Error("Priority must be 0-4 (0 none, 1 urgent, 2 high, 3 medium, 4 low), got 9")).status).toBe(400);
  });
  it("maps anything else to 500 without leaking the message", () => {
    const mapped = toHttpError(new Error("SQLITE_CORRUPT: database disk image is malformed"));
    expect(mapped.status).toBe(500);
    expect(mapped.message).toBe("Internal error");
    expect(toHttpError("string throw").status).toBe(500);
  });
});

describe("board server: SSE", () => {
  beforeEach(async () => {
    await startBoard();
  });

  async function openEvents(): Promise<{ read: () => Promise<string>; close: () => void }> {
    const controller = new AbortController();
    const res = await fetch(`${url}/api/events`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    return {
      read: async () => decoder.decode((await reader.read()).value),
      close: () => controller.abort(),
    };
  }

  it("emits changed after an API mutation", async () => {
    const events = await openEvents();
    expect(await events.read()).toContain(":ok"); // greeting
    await post("/api/tasks", { title: "A" });
    expect(await events.read()).toContain("event: changed");
    events.close();
  });

  it("emits changed when an external process writes the db", async () => {
    const events = await openEvents();
    await events.read(); // greeting
    const external = createTaskStore(dbPath);
    external.createTask({ title: "from agent", actor: "agent" });
    external.close();
    expect(await events.read()).toContain("event: changed");
    events.close();
  }, 10_000);

  it("still broadcasts after a stop/start cycle with a pending broadcast", async () => {
    // Schedule a broadcast, then stop before the 100ms debounce fires.
    await post("/api/tasks", { title: "pending" });
    await server.stop();
    await server.start();
    url = `http://localhost:${server.port}`;
    const events = await openEvents();
    await events.read(); // greeting
    await post("/api/tasks", { title: "after restart" });
    expect(await events.read()).toContain("event: changed");
    events.close();
  });
});

// fetch() (and the underlying undici client) normalizes ".." segments in a
// URL before the request ever leaves the process, so driving a traversal
// attempt through fetch() never actually puts a literal ".." on the wire —
// it can't exercise the server's containment check. To genuinely test that
// check, write a raw HTTP request line over a socket, bypassing any
// client-side URL normalization.
function rawGet(port: number, rawPath: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "localhost", () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf-8");
    });
    socket.on("end", () => {
      const match = /^HTTP\/1\.\d (\d+)/.exec(data);
      resolve({ status: match ? Number(match[1]) : 0 });
    });
    socket.on("error", reject);
  });
}

describe("board server: static files", () => {
  it("serves index.html, assets, and SPA fallback", async () => {
    const dir = await useTmpDir();
    const webDist = path.join(dir, "dist");
    await mkdir(path.join(webDist, "assets"), { recursive: true });
    await writeFile(path.join(webDist, "index.html"), "<html>board</html>");
    await writeFile(path.join(webDist, "assets", "app.js"), "console.log(1)");
    await startBoard({ webDist });

    const root = await fetch(`${url}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await root.text()).toBe("<html>board</html>");

    const js = await fetch(`${url}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript");

    const spa = await fetch(`${url}/task/TASK-1`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toBe("<html>board</html>");
  });

  it("rejects path traversal", async () => {
    const dir = await useTmpDir();
    const webDist = path.join(dir, "dist");
    await mkdir(webDist, { recursive: true });
    await writeFile(path.join(webDist, "index.html"), "ok");
    await writeFile(path.join(dir, "secret.txt"), "secret");
    await startBoard({ webDist });

    // fetch() normalizes "%2e%2e" client-side before the request hits the
    // wire, so this only exercises the extension-heuristic 404 path, not
    // the containment check itself. Kept for coverage of the encoded case.
    const res = await fetch(`${url}/%2e%2e/secret.txt`);
    expect(res.status).toBe(404);

    // A raw request line with a literal ".." can't be normalized away by a
    // client, so this is the case that actually exercises the
    // `filePath.startsWith(root + path.sep)` containment guard in
    // serveStatic. Weakening/removing that guard makes this fail.
    const raw = await rawGet(server.port, "/../secret.txt");
    expect(raw.status).toBe(404);
  });

  it("explains when the UI is not built", async () => {
    await startBoard(); // no webDist
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not built/i);
  });
});
