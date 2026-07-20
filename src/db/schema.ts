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
  // version 0 = fresh file. Future migrations: if (version < 2) { ... } etc.
  db.exec(DDL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
