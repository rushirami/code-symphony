import path from "node:path";
import type { Logger } from "pino";
import type { TrackerClient, TrackerIssue } from "../types.js";
import { createTaskStore, type TaskRecord, type TaskStore } from "../db/store.js";

export interface SqliteTrackerOptions {
  dbPath: string;
  identifierPrefix: string;
  activeStates: string[];
  terminalStates: string[];
}

export function createSqliteTracker(
  opts: SqliteTrackerOptions,
  log: Logger,
): TrackerClient & { close(): void } {
  const store: TaskStore = createTaskStore(opts.dbPath, { identifierPrefix: opts.identifierPrefix });
  const dbName = path.basename(opts.dbPath);
  log.info({ dbPath: opts.dbPath }, "SQLite tracker opened");

  function toIssue(t: TaskRecord): TrackerIssue {
    return {
      id: String(t.id),
      identifier: t.identifier,
      title: t.title,
      description: t.description,
      state: t.state,
      priority: t.priority === 0 ? null : t.priority,
      url: `sqlite://${dbName}/${t.identifier}`,
      labels: t.labels,
      branchName: t.branchName,
      blockedBy: t.blockedBy.map((b) => ({ id: String(b.id), identifier: b.identifier, state: b.state })),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  async function* fetchCandidates(): AsyncGenerator<TrackerIssue[], void, unknown> {
    const tasks = store.listTasks({ states: opts.activeStates });
    if (tasks.length > 0) yield tasks.map(toIssue);
  }

  async function fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (ids.length === 0) return map;
    const wanted = new Set(ids);
    for (const t of store.listTasks()) {
      if (wanted.has(String(t.id))) map.set(String(t.id), t.state);
    }
    return map;
  }

  async function fetchIssuesByStates(states: string[]): Promise<TrackerIssue[]> {
    if (states.length === 0) return [];
    return store.listTasks({ states }).map(toIssue);
  }

  return { fetchCandidates, fetchIssueStatesByIds, fetchIssuesByStates, close: () => store.close() };
}
