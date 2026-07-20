import Database from "better-sqlite3";

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'Backlog'
    CHECK (state IN ('Backlog','Todo','In Progress','In Review','Done','Cancelled')),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  branch_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_labels (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  PRIMARY KEY (task_id, label)
);

CREATE TABLE task_relations (
  blocker_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id != blocked_id)
);

CREATE TABLE task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN
    ('created','state_changed','priority_changed','edited','commented',
     'labeled','unlabeled','blocked','unblocked')),
  old_value TEXT,
  new_value TEXT,
  actor TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_tasks_state ON tasks(state);
CREATE INDEX idx_events_task ON task_events(task_id);

CREATE TRIGGER trg_tasks_updated_at AFTER UPDATE ON tasks
BEGIN
  UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;
`;

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `Database was created by a newer schema (version ${version}, supported ${SCHEMA_VERSION}). Upgrade claude-symphony.`,
    );
  }
  // version < SCHEMA_VERSION: apply migration atomically so two processes racing
  // on a fresh DB cannot both run the DDL. BEGIN IMMEDIATE takes the write lock
  // up front (blocking the loser via busy_timeout); we then re-read user_version
  // inside the lock and only run the DDL if it is still 0. PRAGMA user_version is
  // transactional in SQLite, so the version bump commits atomically with the DDL.
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.pragma("user_version", { simple: true }) as number;
    if (current > SCHEMA_VERSION) {
      db.exec("ROLLBACK");
      db.close();
      throw new Error(
        `Database was created by a newer schema (version ${current}, supported ${SCHEMA_VERSION}). Upgrade claude-symphony.`,
      );
    }
    if (current === 0) {
      // version 0 = fresh file. Future migrations: if (current < 2) { ... } etc.
      db.exec(DDL);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
    // current === SCHEMA_VERSION: another process migrated while we waited; no-op.
    db.exec("COMMIT");
  } catch (err) {
    if (db.open && db.inTransaction) db.exec("ROLLBACK");
    throw err;
  }
}
