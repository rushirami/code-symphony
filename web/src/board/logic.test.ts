import { describe, it, expect } from "vitest";
import { compareCards, groupByState, isBlocked, moveOnDrop, priorityRank } from "./logic";
import type { Task } from "../types";

function task(overrides: Partial<Task>): Task {
  return {
    id: 1, identifier: "TASK-1", title: "t", description: null, state: "Backlog",
    priority: 0, branchName: null, labels: [], blockedBy: [],
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

describe("priorityRank", () => {
  it("treats 0 (none) as lowest priority", () => {
    expect(priorityRank(0)).toBeGreaterThan(priorityRank(4));
    expect(priorityRank(1)).toBeLessThan(priorityRank(2));
  });

  it("maps none (0) to the 999 backend-contract sentinel", () => {
    expect(priorityRank(0)).toBe(999);
  });
});

describe("compareCards", () => {
  it("sorts urgent before none, then newest-updated first", () => {
    const urgent = task({ identifier: "TASK-2", priority: 1 });
    const none = task({ identifier: "TASK-1", priority: 0 });
    const newer = task({ identifier: "TASK-3", priority: 1, updatedAt: "2026-07-15T00:00:00Z" });
    expect([none, urgent, newer].sort(compareCards).map((t) => t.identifier))
      .toEqual(["TASK-3", "TASK-2", "TASK-1"]);
  });
});

describe("groupByState", () => {
  it("creates an entry per requested state, ignoring tasks in other states", () => {
    const groups = groupByState(
      [task({ state: "Todo" }), task({ id: 2, identifier: "TASK-2", state: "Cancelled" })],
      ["Backlog", "Todo"],
    );
    expect([...groups.keys()]).toEqual(["Backlog", "Todo"]);
    expect(groups.get("Backlog")).toEqual([]);
    expect(groups.get("Todo")).toHaveLength(1);
  });

  it("sorts each bucket by compareCards, not insertion order", () => {
    const none = task({ identifier: "TASK-1", state: "Todo", priority: 0, updatedAt: "2026-07-10T00:00:00Z" });
    const urgent = task({ id: 2, identifier: "TASK-2", state: "Todo", priority: 1, updatedAt: "2026-07-01T00:00:00Z" });
    const high = task({ id: 3, identifier: "TASK-3", state: "Todo", priority: 2, updatedAt: "2026-07-05T00:00:00Z" });
    const groups = groupByState([none, urgent, high], ["Todo"]);
    expect(groups.get("Todo")?.map((t) => t.identifier)).toEqual(["TASK-2", "TASK-3", "TASK-1"]);
  });
});

describe("isBlocked", () => {
  it("is true only when a blocker is in a non-terminal state", () => {
    expect(isBlocked(task({ blockedBy: [{ id: 2, identifier: "TASK-2", state: "Todo" }] }))).toBe(true);
    expect(isBlocked(task({ blockedBy: [{ id: 2, identifier: "TASK-2", state: "Done" }] }))).toBe(false);
    expect(isBlocked(task({}))).toBe(false);
  });

  it("is true when only one of several blockers is still non-terminal", () => {
    expect(
      isBlocked(
        task({
          blockedBy: [
            { id: 2, identifier: "TASK-2", state: "Done" },
            { id: 3, identifier: "TASK-3", state: "Todo" },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("moveOnDrop", () => {
  const tasks = [task({ state: "Backlog" })];
  it("returns the move for a valid drop on a different column", () => {
    expect(moveOnDrop(tasks, "TASK-1", "Todo")).toEqual({ identifier: "TASK-1", state: "Todo" });
  });
  it("returns null for same-column drops, unknown targets, and non-string ids", () => {
    expect(moveOnDrop(tasks, "TASK-1", "Backlog")).toBeNull();
    expect(moveOnDrop(tasks, "TASK-1", "NotAState")).toBeNull();
    expect(moveOnDrop(tasks, 7, "Todo")).toBeNull();
    expect(moveOnDrop(tasks, "TASK-9", "Todo")).toBeNull();
  });
});
