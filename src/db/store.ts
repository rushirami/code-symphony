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
  updateState(identifier: string, newState: string, actor: string, note?: string): TaskRecord;
  addComment(identifier: string, author: string, body: string): TaskCommentRecord;
  getComments(identifier: string): TaskCommentRecord[];
  editTask(
    identifier: string,
    changes: { title?: string; description?: string; priority?: number },
    actor: string,
  ): TaskRecord;
  addLabel(identifier: string, label: string, actor: string): void;
  removeLabel(identifier: string, label: string, actor: string): void;
  addBlocker(blockedIdentifier: string, blockerIdentifier: string, actor: string): void;
  removeBlocker(blockedIdentifier: string, blockerIdentifier: string, actor: string): void;
  getHistory(identifier: string): TaskEventRecord[];
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
       JOIN tasks t ON t.id = r.blocker_id WHERE r.blocked_id = ?
       ORDER BY t.id`,
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

  const createTaskTx = db.transaction((input: CreateTaskInput): TaskRecord => {
    const state = input.state ? canonicalState(input.state) : "Backlog";
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
      throw new Error(`Priority must be 0-4 (0 none, 1 urgent, 2 high, 3 medium, 4 low), got ${priority}`);
    }
    const ts = now();
    const nextId = db.prepare(
      "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'tasks'), 0) + 1",
    ).pluck().get() as number;
    const identifier = `${prefix}-${nextId}`;
    const info = db.prepare(
      `INSERT INTO tasks (identifier, title, description, state, priority, branch_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(identifier, input.title, input.description ?? null, state, priority, input.branchName ?? null, ts, ts);
    const id = Number(info.lastInsertRowid);
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

  function insertComment(taskId: number, author: string, body: string): TaskCommentRecord {
    const ts = now();
    const info = db.prepare(
      "INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)",
    ).run(taskId, author, body, ts);
    logEvent(taskId, "commented", null, null, author, body);
    return { id: Number(info.lastInsertRowid), taskId, author, body, createdAt: ts };
  }

  const updateStateTx = db.transaction(
    (identifier: string, newState: string, actor: string, note?: string): TaskRecord => {
      const row = requireRow(identifier);
      const state = canonicalState(newState);
      db.prepare("UPDATE tasks SET state = ? WHERE id = ?").run(state, row.id);
      logEvent(row.id, "state_changed", row.state, state, actor, note ?? null);
      if (note) insertComment(row.id, actor, note);
      return rowToRecord(requireRow(identifier));
    },
  );

  const addCommentTx = db.transaction(
    (identifier: string, author: string, body: string): TaskCommentRecord => {
      const row = requireRow(identifier);
      return insertComment(row.id, author, body);
    },
  );

  function getComments(identifier: string): TaskCommentRecord[] {
    const row = requireRow(identifier);
    return (db.prepare(
      "SELECT id, task_id, author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY id",
    ).all(row.id) as Array<{ id: number; task_id: number; author: string; body: string; created_at: string }>)
      .map((r) => ({ id: r.id, taskId: r.task_id, author: r.author, body: r.body, createdAt: r.created_at }));
  }

  const editTaskTx = db.transaction(
    (identifier: string, changes: { title?: string; description?: string; priority?: number }, actor: string): TaskRecord => {
      const row = requireRow(identifier);
      const edited: string[] = [];
      if (changes.title !== undefined && changes.title !== row.title) {
        db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run(changes.title, row.id);
        edited.push("title");
      }
      if (changes.description !== undefined && changes.description !== row.description) {
        db.prepare("UPDATE tasks SET description = ? WHERE id = ?").run(changes.description, row.id);
        edited.push("description");
      }
      if (edited.length > 0) logEvent(row.id, "edited", null, edited.join(","), actor, null);
      if (changes.priority !== undefined && changes.priority !== row.priority) {
        if (!Number.isInteger(changes.priority) || changes.priority < 0 || changes.priority > 4) {
          throw new Error(`Priority must be 0-4 (0 none, 1 urgent, 2 high, 3 medium, 4 low), got ${changes.priority}`);
        }
        db.prepare("UPDATE tasks SET priority = ? WHERE id = ?").run(changes.priority, row.id);
        logEvent(row.id, "priority_changed", String(row.priority), String(changes.priority), actor, null);
      }
      return rowToRecord(requireRow(identifier));
    },
  );

  const addLabelTx = db.transaction((identifier: string, label: string, actor: string): void => {
    const row = requireRow(identifier);
    const norm = label.toLowerCase();
    const info = db.prepare("INSERT OR IGNORE INTO task_labels (task_id, label) VALUES (?, ?)").run(row.id, norm);
    if (info.changes > 0) logEvent(row.id, "labeled", null, norm, actor, null);
  });

  const removeLabelTx = db.transaction((identifier: string, label: string, actor: string): void => {
    const row = requireRow(identifier);
    const norm = label.toLowerCase();
    const info = db.prepare("DELETE FROM task_labels WHERE task_id = ? AND label = ?").run(row.id, norm);
    if (info.changes > 0) logEvent(row.id, "unlabeled", norm, null, actor, null);
  });

  const addBlockerTx = db.transaction(
    (blockedIdentifier: string, blockerIdentifier: string, actor: string): void => {
      const blocked = requireRow(blockedIdentifier);
      const blocker = requireRow(blockerIdentifier);
      const info = db.prepare(
        "INSERT OR IGNORE INTO task_relations (blocker_id, blocked_id) VALUES (?, ?)",
      ).run(blocker.id, blocked.id);
      if (info.changes > 0) logEvent(blocked.id, "blocked", null, blockerIdentifier, actor, null);
    },
  );

  const removeBlockerTx = db.transaction(
    (blockedIdentifier: string, blockerIdentifier: string, actor: string): void => {
      const blocked = requireRow(blockedIdentifier);
      const blocker = requireRow(blockerIdentifier);
      const info = db.prepare(
        "DELETE FROM task_relations WHERE blocker_id = ? AND blocked_id = ?",
      ).run(blocker.id, blocked.id);
      if (info.changes > 0) logEvent(blocked.id, "unblocked", blockerIdentifier, null, actor, null);
    },
  );

  function getHistory(identifier: string): TaskEventRecord[] {
    const row = requireRow(identifier);
    return (db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id").all(row.id) as Array<{
      id: number; task_id: number; kind: string; old_value: string | null;
      new_value: string | null; actor: string; note: string | null; created_at: string;
    }>).map((r) => ({
      id: r.id, taskId: r.task_id, kind: r.kind, oldValue: r.old_value,
      newValue: r.new_value, actor: r.actor, note: r.note, createdAt: r.created_at,
    }));
  }

  return {
    createTask: (input: CreateTaskInput) => createTaskTx.immediate(input),
    getTask,
    listTasks,
    updateState: (identifier: string, newState: string, actor: string, note?: string) =>
      updateStateTx.immediate(identifier, newState, actor, note),
    addComment: (identifier: string, author: string, body: string) =>
      addCommentTx.immediate(identifier, author, body),
    getComments,
    editTask: (
      identifier: string,
      changes: { title?: string; description?: string; priority?: number },
      actor: string,
    ) => editTaskTx.immediate(identifier, changes, actor),
    addLabel: (identifier: string, label: string, actor: string) => addLabelTx.immediate(identifier, label, actor),
    removeLabel: (identifier: string, label: string, actor: string) =>
      removeLabelTx.immediate(identifier, label, actor),
    addBlocker: (blockedIdentifier: string, blockerIdentifier: string, actor: string) =>
      addBlockerTx.immediate(blockedIdentifier, blockerIdentifier, actor),
    removeBlocker: (blockedIdentifier: string, blockerIdentifier: string, actor: string) =>
      removeBlockerTx.immediate(blockedIdentifier, blockerIdentifier, actor),
    getHistory,
    close: () => db.close(),
  };
}
