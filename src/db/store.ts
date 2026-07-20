import type Database from "better-sqlite3";
import { openDatabase } from "./schema.js";

export const STATES = ["Backlog", "Todo", "In Progress", "In Review", "Done", "Cancelled"] as const;
export type TaskState = (typeof STATES)[number];

export interface BlockerInfo {
  id: number;
  identifier: string;
  state: string;
}

export interface TaskRecord {
  id: number;
  identifier: string;
  title: string;
  description: string | null;
  state: string;
  priority: number;
  branchName: string | null;
  labels: string[];
  blockedBy: BlockerInfo[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskCommentRecord {
  id: number;
  taskId: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface TaskEventRecord {
  id: number;
  taskId: number;
  kind: string;
  oldValue: string | null;
  newValue: string | null;
  actor: string;
  note: string | null;
  createdAt: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  state?: string;
  priority?: number;
  labels?: string[];
  branchName?: string | null;
  blockedBy?: string[];
  actor: string;
}

export interface TaskStore {
  createTask(input: CreateTaskInput): TaskRecord;
  getTask(identifier: string): TaskRecord | undefined;
  listTasks(filter?: { states?: string[]; labels?: string[] }): TaskRecord[];
  // Task 3 adds: updateState, addComment, getComments, editTask,
  //   addLabel, removeLabel, addBlocker, removeBlocker, getHistory
  close(): void;
}

interface TaskRow {
  id: number;
  identifier: string;
  title: string;
  description: string | null;
  state: string;
  priority: number;
  branch_name: string | null;
  created_at: string;
  updated_at: string;
}

export function createTaskStore(
  dbPath: string,
  opts: { identifierPrefix?: string } = {},
): TaskStore {
  const prefix = opts.identifierPrefix ?? "TASK";
  const db: Database.Database = openDatabase(dbPath);

  function canonicalState(input: string): TaskState {
    const match = STATES.find((s) => s.toLowerCase() === input.toLowerCase());
    if (!match) {
      throw new Error(`Unknown state "${input}". Valid states: ${STATES.join(", ")}`);
    }
    return match;
  }

  const now = () => new Date().toISOString();

  function logEvent(
    taskId: number,
    kind: string,
    oldValue: string | null,
    newValue: string | null,
    actor: string,
    note: string | null,
  ): void {
    db.prepare(
      `INSERT INTO task_events (task_id, kind, old_value, new_value, actor, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(taskId, kind, oldValue, newValue, actor, note, now());
  }

  function requireRow(identifier: string): TaskRow {
    const row = db.prepare("SELECT * FROM tasks WHERE identifier = ?").get(identifier) as TaskRow | undefined;
    if (!row) throw new Error(`No task with identifier "${identifier}"`);
    return row;
  }

  function rowToRecord(row: TaskRow): TaskRecord {
    const labels = (db.prepare("SELECT label FROM task_labels WHERE task_id = ? ORDER BY label")
      .all(row.id) as Array<{ label: string }>).map((r) => r.label);
    const blockedBy = db.prepare(
      `SELECT t.id, t.identifier, t.state FROM task_relations r
       JOIN tasks t ON t.id = r.blocker_id WHERE r.blocked_id = ?`,
    ).all(row.id) as BlockerInfo[];
    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      description: row.description,
      state: row.state,
      priority: row.priority,
      branchName: row.branch_name,
      labels,
      blockedBy,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  const createTask = db.transaction((input: CreateTaskInput): TaskRecord => {
    const state = input.state ? canonicalState(input.state) : "Backlog";
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
      throw new Error(`Priority must be 0-4 (0 none, 1 urgent, 2 high, 3 medium, 4 low), got ${priority}`);
    }
    const ts = now();
    const info = db.prepare(
      `INSERT INTO tasks (identifier, title, description, state, priority, branch_name, created_at, updated_at)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.title, input.description ?? null, state, priority, input.branchName ?? null, ts, ts);
    const id = Number(info.lastInsertRowid);
    const identifier = `${prefix}-${id}`;
    db.prepare("UPDATE tasks SET identifier = ? WHERE id = ?").run(identifier, id);
    for (const label of input.labels ?? []) {
      db.prepare("INSERT OR IGNORE INTO task_labels (task_id, label) VALUES (?, ?)")
        .run(id, label.toLowerCase());
    }
    for (const blockerIdent of input.blockedBy ?? []) {
      const blocker = requireRow(blockerIdent);
      db.prepare("INSERT OR IGNORE INTO task_relations (blocker_id, blocked_id) VALUES (?, ?)")
        .run(blocker.id, id);
    }
    logEvent(id, "created", null, state, input.actor, null);
    return rowToRecord(requireRow(identifier));
  });

  function getTask(identifier: string): TaskRecord | undefined {
    const row = db.prepare("SELECT * FROM tasks WHERE identifier = ?").get(identifier) as TaskRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  function listTasks(filter: { states?: string[]; labels?: string[] } = {}): TaskRecord[] {
    let rows = db.prepare(
      `SELECT * FROM tasks
       ORDER BY CASE priority WHEN 0 THEN 999 ELSE priority END, created_at, id`,
    ).all() as TaskRow[];
    if (filter.states) {
      const wanted = new Set<string>(filter.states.map((s) => canonicalState(s)));
      rows = rows.filter((r) => wanted.has(r.state));
    }
    let records = rows.map(rowToRecord);
    if (filter.labels?.length) {
      const wanted = filter.labels.map((l) => l.toLowerCase());
      records = records.filter((rec) => wanted.every((l) => rec.labels.includes(l)));
    }
    return records;
  }

  return { createTask, getTask, listTasks, close: () => db.close() };
}
