import { describe, it, expect } from "vitest";
import { createStateManager } from "../src/orchestrator/state.js";
import { makeIssue } from "./helpers.js";

describe("StateManager", () => {
  it("claim creates a worker in claimed phase", () => {
    const sm = createStateManager();
    const issue = makeIssue();
    const worker = sm.claim(issue);

    expect(worker.phase).toBe("claimed");
    expect(worker.issue.identifier).toBe("PROJ-1");
    expect(worker.attempts).toBe(0);
    expect(worker.sessionId).toBeNull();
    expect(worker.claimedAt).toBeGreaterThan(0);
  });

  it("claim throws on duplicate identifier", () => {
    const sm = createStateManager();
    sm.claim(makeIssue());
    expect(() => sm.claim(makeIssue())).toThrow("Already tracked: PROJ-1");
  });

  it("markRunning transitions claimed → running", () => {
    const sm = createStateManager();
    sm.claim(makeIssue());
    sm.markRunning("PROJ-1", "session-abc");

    const w = sm.getWorker("PROJ-1")!;
    expect(w.phase).toBe("running");
    expect(w.sessionId).toBe("session-abc");
    expect(w.startedAt).toBeGreaterThan(0);
    expect(w.lastActivityAt).toBeGreaterThan(0);
  });

  it("markRunning throws on non-claimed worker", () => {
    const sm = createStateManager();
    expect(() => sm.markRunning("PROJ-1", "s")).toThrow("No worker");
  });

  it("markRunning throws if worker is not in claimed phase", () => {
    const sm = createStateManager();
    sm.claim(makeIssue());
    sm.markRunning("PROJ-1", "s");
    expect(() => sm.markRunning("PROJ-1", "s2")).toThrow("Invalid transition");
  });

  it("markCompleted removes entry", () => {
    const sm = createStateManager();
    sm.claim(makeIssue());
    sm.markRunning("PROJ-1", "s");
    sm.markCompleted("PROJ-1");

    expect(sm.getWorker("PROJ-1")).toBeUndefined();
    expect(sm.getRunning()).toHaveLength(0);
  });

  it("markCompleted removes entry from any phase", () => {
    const sm = createStateManager();
    sm.claim(makeIssue());
    // Can complete from claimed phase (e.g., after continuation check)
    sm.markCompleted("PROJ-1");
    expect(sm.getWorker("PROJ-1")).toBeUndefined();
  });

  it("markAwaitingContinuation transitions running → claimed", () => {
    const sm = createStateManager();
    sm.claim(makeIssue());
    sm.markRunning("PROJ-1", "s1");
    sm.markAwaitingContinuation("PROJ-1");

    const w = sm.getWorker("PROJ-1")!;
    expect(w.phase).toBe("claimed");
    expect(w.sessionId).toBe("s1"); // preserved
  });

  it("tracks turnsCompleted and totalCostUsd", () => {
    const sm = createStateManager();
    const w = sm.claim(makeIssue());
    expect(w.turnsCompleted).toBe(0);
    expect(w.totalCostUsd).toBe(0);

    sm.markRunning("PROJ-1", "s1");
    const worker = sm.getWorker("PROJ-1")!;
    worker.turnsCompleted = 3;
    worker.totalCostUsd = 0.15;

    const snap = sm.toSnapshot();
    expect(snap.totalTurnsCompleted).toBe(3);
    expect(snap.totalCostUsd).toBe(0.15);
  });

  it("markFailed with attempts < max queues retry", () => {
    const sm = createStateManager();
    sm.claim(makeIssue());
    sm.markRunning("PROJ-1", "s");

    const before = Date.now();
    sm.markFailed("PROJ-1", "agent crashed", 3, 5000);

    const w = sm.getWorker("PROJ-1")!;
    expect(w.phase).toBe("retry_queued");
    expect(w.attempts).toBe(1);
    expect(w.lastError).toBe("agent crashed");
    expect(w.retryAfter).toBeGreaterThanOrEqual(before + 5000);
  });

  it("markFailed with attempts >= max removes entry", () => {
    const sm = createStateManager();
    sm.claim(makeIssue());
    sm.markRunning("PROJ-1", "s");

    // maxRetries = 1 means after 1 failure it's exhausted
    sm.markFailed("PROJ-1", "error", 1, 5000);
    expect(sm.getWorker("PROJ-1")).toBeUndefined();
  });

  it("release removes entry from any phase", () => {
    const sm = createStateManager();
    sm.claim(makeIssue());
    sm.release("PROJ-1");
    expect(sm.getWorker("PROJ-1")).toBeUndefined();

    // Also works if not found (no-op)
    sm.release("NONEXISTENT"); // should not throw
  });

  it("getRunning returns only running workers", () => {
    const sm = createStateManager();
    sm.claim(makeIssue({ identifier: "PROJ-1" }));
    sm.claim(makeIssue({ identifier: "PROJ-2", id: "uuid-2" }));
    sm.markRunning("PROJ-1", "s1");

    expect(sm.getRunning()).toHaveLength(1);
    expect(sm.getRunning()[0].issue.identifier).toBe("PROJ-1");
  });

  it("getClaimed returns only claimed workers", () => {
    const sm = createStateManager();
    sm.claim(makeIssue({ identifier: "PROJ-1" }));
    sm.claim(makeIssue({ identifier: "PROJ-2", id: "uuid-2" }));
    sm.markRunning("PROJ-1", "s1");

    expect(sm.getClaimed()).toHaveLength(1);
    expect(sm.getClaimed()[0].issue.identifier).toBe("PROJ-2");
  });

  it("getRetryReady returns workers past retryAfter", () => {
    const sm = createStateManager();
    sm.claim(makeIssue());
    sm.markRunning("PROJ-1", "s");
    sm.markFailed("PROJ-1", "err", 3, 0); // retryDelay = 0 → immediately ready

    const ready = sm.getRetryReady();
    expect(ready).toHaveLength(1);
    expect(ready[0].issue.identifier).toBe("PROJ-1");
  });

  it("getRetryReady returns empty when retryAfter is in future", () => {
    const sm = createStateManager();
    sm.claim(makeIssue());
    sm.markRunning("PROJ-1", "s");
    sm.markFailed("PROJ-1", "err", 3, 999_999); // far future

    expect(sm.getRetryReady()).toHaveLength(0);
  });

  it("toSnapshot returns serializable state", () => {
    const sm = createStateManager();
    sm.claim(makeIssue({ identifier: "PROJ-1" }));
    sm.claim(makeIssue({ identifier: "PROJ-2", id: "uuid-2" }));
    sm.markRunning("PROJ-1", "s");

    const snap = sm.toSnapshot();
    expect(snap.runningCount).toBe(1);
    expect(snap.claimedCount).toBe(1);
    expect(snap.retryQueuedCount).toBe(0);
    expect(snap.workers).toHaveLength(2);

    // Verify it's JSON-serializable
    const json = JSON.stringify(snap);
    const parsed = JSON.parse(json);
    expect(parsed.runningCount).toBe(1);
  });

  it("full lifecycle: claim → running → completed", () => {
    const sm = createStateManager();
    sm.claim(makeIssue());
    sm.markRunning("PROJ-1", "session-1");
    sm.markCompleted("PROJ-1");

    expect(sm.getAllActive()).toHaveLength(0);
    expect(sm.toSnapshot().workers).toHaveLength(0);
  });

  it("full retry lifecycle: claim → running → retry → reclaim → running → completed", () => {
    const sm = createStateManager();
    const issue = makeIssue();

    sm.claim(issue);
    sm.markRunning("PROJ-1", "s1");
    sm.markFailed("PROJ-1", "first failure", 3, 0);

    expect(sm.getWorker("PROJ-1")!.phase).toBe("retry_queued");
    expect(sm.getRetryReady()).toHaveLength(1);

    // Re-claim for retry: release retry_queued, then re-claim
    const w = sm.getWorker("PROJ-1")!;
    const attempts = w.attempts;
    const sessionId = w.sessionId;

    // To retry: release old entry, claim fresh, preserve attempts + sessionId
    sm.release("PROJ-1");
    const fresh = sm.claim(issue);
    fresh.attempts = attempts;
    fresh.sessionId = sessionId;

    sm.markRunning("PROJ-1", "s2");
    sm.markCompleted("PROJ-1");

    expect(sm.getAllActive()).toHaveLength(0);
  });
});
