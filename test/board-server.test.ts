import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import pino from "pino";
import { createBoardServer, toHttpError, type BoardServer } from "../src/board/server.js";
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
