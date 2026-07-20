import { describe, it, expect } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { openDatabase, SCHEMA_VERSION } from "../src/db/schema.js";
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
