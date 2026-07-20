import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawn } from "node:child_process";
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

  it("two processes migrating the SAME fresh db concurrently both succeed", async () => {
    const dir = await useTmpDir();
    const dbPath = path.join(dir, "race.db");
    const schema = path.resolve(import.meta.dirname, "../src/db/schema.ts");
    // Each child dynamically imports the schema module and opens the same fresh db.
    // Without the atomic BEGIN IMMEDIATE migration, the loser of the race throws
    // "table tasks already exists"; with it, the loser re-reads user_version==1
    // inside the lock and no-ops.
    const code = `import(${JSON.stringify(schema)}).then((m) => {`
      + ` const db = m.openDatabase(process.env.RACE_DB); db.close(); process.exit(0);`
      + ` }).catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });`;
    const spawnOne = () =>
      new Promise<{ code: number; stderr: string }>((resolve) => {
        const cp = spawn("npx", ["tsx", "-e", code], {
          env: { ...process.env, RACE_DB: dbPath },
        });
        let stderr = "";
        cp.stderr.on("data", (d) => { stderr += String(d); });
        cp.on("close", (c) => resolve({ code: c ?? 1, stderr }));
      });
    const [a, b] = await Promise.all([spawnOne(), spawnOne()]);
    expect(a.code, `proc A stderr: ${a.stderr}`).toBe(0);
    expect(b.code, `proc B stderr: ${b.stderr}`).toBe(0);
    // The db is usable and at the expected version afterward.
    const db = openDatabase(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  }, 30000);
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

describe("TaskStore mutations and history", () => {
  it("updateState logs state_changed; with note also stores a comment in one transaction", async () => {
    const store = await makeStore();
    const t = store.createTask({ title: "x", state: "Todo", actor: "rushi" });
    store.updateState(t.identifier, "In Progress", "rushi");
    const done = store.updateState(t.identifier, "done", "agent:TASK-1", "All tests green");
    expect(done.state).toBe("Done");
    const comments = store.getComments(t.identifier);
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe("agent:TASK-1");
    expect(comments[0].body).toBe("All tests green");
    const kinds = store.getHistory(t.identifier).map((e) => e.kind);
    expect(kinds).toEqual(["created", "state_changed", "state_changed", "commented"]);
    const last = store.getHistory(t.identifier).filter((e) => e.kind === "state_changed").at(-1)!;
    expect(last.oldValue).toBe("In Progress");
    expect(last.newValue).toBe("Done");
    store.close();
  });

  it("updateState without note appends exactly one event", async () => {
    const store = await makeStore();
    const t = store.createTask({ title: "x", actor: "a" });
    const before = store.getHistory(t.identifier).length;
    store.updateState(t.identifier, "Todo", "a");
    expect(store.getHistory(t.identifier).length).toBe(before + 1);
    store.close();
  });

  it("rejects unknown identifiers with an actionable message", async () => {
    const store = await makeStore();
    expect(() => store.updateState("TASK-99", "Done", "a"))
      .toThrow('No task with identifier "TASK-99"');
    store.close();
  });

  it("editTask logs edited and priority_changed separately", async () => {
    const store = await makeStore();
    const t = store.createTask({ title: "old", priority: 3, actor: "a" });
    const updated = store.editTask(t.identifier, { title: "new", priority: 1 }, "a");
    expect(updated.title).toBe("new");
    expect(updated.priority).toBe(1);
    const kinds = store.getHistory(t.identifier).map((e) => e.kind);
    expect(kinds).toContain("edited");
    expect(kinds).toContain("priority_changed");
    const pc = store.getHistory(t.identifier).find((e) => e.kind === "priority_changed")!;
    expect(pc.oldValue).toBe("3");
    expect(pc.newValue).toBe("1");
    store.close();
  });

  it("label add/remove and block/unblock update records and history", async () => {
    const store = await makeStore();
    const a = store.createTask({ title: "a", actor: "u" });
    const b = store.createTask({ title: "b", actor: "u" });
    store.addLabel(a.identifier, "Bug", "u");
    expect(store.getTask(a.identifier)!.labels).toEqual(["bug"]);
    store.removeLabel(a.identifier, "bug", "u");
    expect(store.getTask(a.identifier)!.labels).toEqual([]);
    store.addBlocker(b.identifier, a.identifier, "u");
    expect(store.getTask(b.identifier)!.blockedBy.map((x) => x.identifier)).toEqual([a.identifier]);
    store.removeBlocker(b.identifier, a.identifier, "u");
    expect(store.getTask(b.identifier)!.blockedBy).toEqual([]);
    const kinds = store.getHistory(b.identifier).map((e) => e.kind);
    expect(kinds).toContain("blocked");
    expect(kinds).toContain("unblocked");
    store.close();
  });

  it("addComment stores markdown verbatim and logs commented with the body as note", async () => {
    const store = await makeStore();
    const t = store.createTask({ title: "x", actor: "a" });
    const md = "## Progress\n- [x] step one\n**bold**";
    store.addComment(t.identifier, "rushi", md);
    expect(store.getComments(t.identifier)[0].body).toBe(md);
    expect(store.getHistory(t.identifier).find((e) => e.kind === "commented")!.note).toBe(md);
    store.close();
  });
});
