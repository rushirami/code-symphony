import path from "node:path";
import type { Logger } from "pino";
import type { TrackerClient, TrackerConfig, TrackerIssue } from "../types.js";
import { createTaskStore, type TaskRecord, type TaskStore } from "../db/store.js";

export function createSqliteTracker(
  config: TrackerConfig,
  log: Logger,
): TrackerClient & { close(): void } {
  const store: TaskStore = createTaskStore(config.dbPath, { identifierPrefix: config.identifierPrefix });
  const dbName = path.basename(config.dbPath);
  log.info({ dbPath: config.dbPath }, "SQLite tracker opened");

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
    const tasks = store.listTasks({ states: config.activeStates });
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
