import { describe, it, expect } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { openDatabase, SCHEMA_VERSION } from "../src/db/schema.js";
import { createTaskStore, STATES } from "../src/db/store.js";
import { useTmpDir } from "./helpers.js";

describe("schema", () => {
  it("creates all tables, indexes and sets user_version", async () => {
    const dir = await useTmpDir();
    const db = openDatabase(path.join(dir, "tasks.db"));
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(names).toContain("tasks");
    expect(names).toContain("task_labels");
    expect(names).toContain("task_relations");
    expect(names).toContain("task_comments");
    expect(names).toContain("task_events");
    expect(names).toContain("trg_tasks_updated_at");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
  });

  it("reopening an existing db is a no-op migration", async () => {
    const dir = await useTmpDir();
    const p = path.join(dir, "tasks.db");
    openDatabase(p).close();
    const db = openDatabase(p); // must not throw "table already exists"
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("refuses a db from a newer schema version", async () => {
    const dir = await useTmpDir();
    const p = path.join(dir, "tasks.db");
    const raw = new Database(p);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openDatabase(p)).toThrow(/newer schema/i);
  });
});

async function makeStore() {
  const dir = await useTmpDir();
  return createTaskStore(path.join(dir, "tasks.db"));
}

describe("TaskStore create/get/list", () => {
  it("creates a task with generated identifier and logs a created event", async () => {
    const store = await makeStore();
    const t = store.createTask({ title: "Fix login", description: "SSO broken", actor: "rushi" });
    expect(t.identifier).toBe("TASK-1");
    expect(t.state).toBe("Backlog");
    expect(t.priority).toBe(0);
    expect(store.createTask({ title: "Second", actor: "rushi" }).identifier).toBe("TASK-2");
    const fetched = store.getTask("TASK-1")!;
    expect(fetched.title).toBe("Fix login");
    expect(fetched.description).toBe("SSO broken");
    store.close();
  });

  it("respects a custom identifier prefix", async () => {
    const dir = await useTmpDir();
    const store = createTaskStore(path.join(dir, "t.db"), { identifierPrefix: "SYM" });
    expect(store.createTask({ title: "x", actor: "a" }).identifier).toBe("SYM-1");
    store.close();
  });

  it("canonicalizes state case-insensitively and rejects unknown states", async () => {
    const store = await makeStore();
    const t = store.createTask({ title: "x", state: "in progress", actor: "a" });
    expect(t.state).toBe("In Progress");
    expect(() => store.createTask({ title: "y", state: "Nope", actor: "a" }))
      .toThrow(`Unknown state "Nope". Valid states: ${STATES.join(", ")}`);
    store.close();
  });

  it("stores labels lowercased and blockedBy relations", async () => {
    const store = await makeStore();
    const blocker = store.createTask({ title: "schema", state: "Todo", actor: "a" });
    const t = store.createTask({
      title: "api", state: "Todo", labels: ["Bug", "AUTH"],
      blockedBy: [blocker.identifier], actor: "a",
    });
    expect(t.labels).toEqual(["auth", "bug"]);
    expect(t.blockedBy).toEqual([{ id: blocker.id, identifier: "TASK-1", state: "Todo" }]);
    store.close();
  });

  it("lists with state/label filters, ordered urgent→low then none, ties by created_at", async () => {
    const store = await makeStore();
    store.createTask({ title: "none-pri", state: "Todo", priority: 0, actor: "a" });
    store.createTask({ title: "low", state: "Todo", priority: 4, actor: "a" });
    store.createTask({ title: "urgent", state: "Todo", priority: 1, actor: "a" });
    store.createTask({ title: "done", state: "Done", priority: 1, actor: "a" });
    store.createTask({ title: "labeled", state: "Todo", priority: 2, labels: ["bug"], actor: "a" });
    const todos = store.listTasks({ states: ["Todo"] });
    expect(todos.map((t) => t.title)).toEqual(["urgent", "labeled", "low", "none-pri"]);
    expect(store.listTasks({ states: ["todo"], labels: ["BUG"] }).map((t) => t.title)).toEqual(["labeled"]);
    expect(store.listTasks().length).toBe(5);
    store.close();
  });

  it("rejects out-of-range priority", async () => {
    const store = await makeStore();
    expect(() => store.createTask({ title: "x", priority: 7, actor: "a" })).toThrow(/Priority must be 0-4/);
    store.close();
  });

  it("keeps createdAt === updatedAt on a freshly created task and logs a created event", async () => {
    const dir = await useTmpDir();
    const dbPath = path.join(dir, "tasks.db");
    const store = createTaskStore(dbPath);
    const t = store.createTask({ title: "Fix login", actor: "rushi" });
    expect(t.identifier).toBe(`TASK-${t.id}`);
    expect(t.updatedAt).toBe(t.createdAt);
    store.close();

    const raw = new Database(dbPath, { readonly: true });
    const events = raw
      .prepare("SELECT kind FROM task_events WHERE task_id = ?")
      .all(t.id) as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toEqual(["created"]);
    raw.close();
  });
});
