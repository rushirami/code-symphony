import { describe, it, expect } from "vitest";
import path from "node:path";
import pino from "pino";
import { createSqliteTracker } from "../src/tracker/sqlite.js";
import { createTaskStore } from "../src/db/store.js";
import { useTmpDir } from "./helpers.js";

const log = pino({ level: "silent" });

async function setup() {
  const dir = await useTmpDir();
  const dbPath = path.join(dir, "tasks.db");
  const store = createTaskStore(dbPath);
  const tracker = createSqliteTracker(
    { dbPath, identifierPrefix: "TASK", activeStates: ["Todo", "In Progress"], terminalStates: ["Done", "Cancelled"] },
    log,
  );
  return { store, tracker, dbPath };
}

describe("SqliteTracker", () => {
  it("fetchCandidates yields active tasks mapped to TrackerIssue", async () => {
    const { store, tracker } = await setup();
    store.createTask({ title: "backlog item", state: "Backlog", actor: "t" });
    const a = store.createTask({ title: "urgent", state: "Todo", priority: 1, labels: ["Bug"], actor: "t" });
    store.createTask({ title: "in prog", state: "In Progress", priority: 2, actor: "t" });

    const pages = [];
    for await (const page of tracker.fetchCandidates()) pages.push(page);
    expect(pages).toHaveLength(1);
    const issues = pages[0];
    expect(issues.map((i) => i.title)).toEqual(["urgent", "in prog"]);
    const issue = issues[0];
    expect(issue.id).toBe(String(a.id));
    expect(issue.identifier).toBe("TASK-2");
    expect(issue.state).toBe("Todo");
    expect(issue.priority).toBe(1);
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.url).toBe("sqlite://tasks.db/TASK-2");
    tracker.close(); store.close();
  });

  it("maps priority 0 to null so unprioritized tasks sort last in the orchestrator", async () => {
    const { store, tracker } = await setup();
    store.createTask({ title: "no pri", state: "Todo", priority: 0, actor: "t" });
    for await (const page of tracker.fetchCandidates()) {
      expect(page[0].priority).toBeNull();
    }
    tracker.close(); store.close();
  });

  it("maps blockedBy relations", async () => {
    const { store, tracker } = await setup();
    const blocker = store.createTask({ title: "first", state: "In Progress", actor: "t" });
    store.createTask({ title: "second", state: "Todo", blockedBy: [blocker.identifier], actor: "t" });
    for await (const page of tracker.fetchCandidates()) {
      const second = page.find((i) => i.title === "second")!;
      expect(second.blockedBy).toEqual([{ id: String(blocker.id), identifier: blocker.identifier, state: "In Progress" }]);
    }
    tracker.close(); store.close();
  });

  it("fetchIssueStatesByIds returns current states keyed by id", async () => {
    const { store, tracker } = await setup();
    const t = store.createTask({ title: "x", state: "Todo", actor: "t" });
    store.updateState(t.identifier, "Done", "t");
    const map = await tracker.fetchIssueStatesByIds([String(t.id), "9999"]);
    expect(map.get(String(t.id))).toBe("Done");
    expect(map.has("9999")).toBe(false);
    expect((await tracker.fetchIssueStatesByIds([])).size).toBe(0);
    tracker.close(); store.close();
  });

  it("fetchIssuesByStates filters by the given states", async () => {
    const { store, tracker } = await setup();
    store.createTask({ title: "done1", state: "Done", actor: "t" });
    store.createTask({ title: "todo1", state: "Todo", actor: "t" });
    const done = await tracker.fetchIssuesByStates(["Done", "Cancelled"]);
    expect(done.map((i) => i.title)).toEqual(["done1"]);
    expect(await tracker.fetchIssuesByStates([])).toEqual([]);
    tracker.close(); store.close();
  });

  it("sees writes made by a separate store connection (CLI simulation)", async () => {
    const { store, tracker, dbPath } = await setup();
    const t = store.createTask({ title: "x", state: "Todo", actor: "t" });
    // separate connection to the same file, like the CLI running in another process
    const other = createTaskStore(dbPath);
    other.updateState(t.identifier, "Done", "cli-user");
    other.close();
    const map = await tracker.fetchIssueStatesByIds([String(t.id)]);
    expect(map.get(String(t.id))).toBe("Done");
    tracker.close(); store.close();
  });
});
