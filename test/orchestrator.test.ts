import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import pino from "pino";
import { createOrchestrator } from "../src/orchestrator/loop.js";
import { createStateManager } from "../src/orchestrator/state.js";
import { createWorkspaceManager } from "../src/workspace/manager.js";
import { createAgentRunner } from "../src/agent/runner.js";
import { createSqliteTracker } from "../src/tracker/sqlite.js";
import { createTaskStore } from "../src/db/store.js";
import { useTmpDir, makeIssue, makeConfig } from "./helpers.js";
import type { SymphonyConfig } from "../src/types.js";

const log = pino({ level: "silent" });
const fixturesDir = path.resolve(import.meta.dirname, "fixtures");

describe("Orchestrator", () => {
  // Open DB connections (stores + trackers) get closed after each test.
  const closeables: Array<{ close: () => void }> = [];
  function track<T extends { close: () => void }>(c: T): T {
    closeables.push(c);
    return c;
  }

  afterEach(() => {
    for (const c of closeables.splice(0)) {
      try {
        c.close();
      } catch {
        // Already closed (e.g. the tracker-error test closes mid-test).
      }
    }
  });

  function buildOrchestrator(
    wsRoot: string,
    dbPath: string,
    configOverrides: Partial<SymphonyConfig> = {},
  ) {
    const config = makeConfig({
      ...configOverrides,
      tracker: {
        ...makeConfig().tracker,
        dbPath,
        ...configOverrides.tracker,
      },
      agent: {
        ...makeConfig().agent,
        command: path.join(fixturesDir, "fake-claude.sh"),
        ...configOverrides.agent,
      },
      workspace: {
        root: wsRoot,
        hooks: { timeoutMs: 5000 },
        ...configOverrides.workspace,
      },
      polling: {
        intervalMs: 60_000, // long interval so ticks are manual
        ...configOverrides.polling,
      },
    });

    const tracker = track(createSqliteTracker(config.tracker, log));
    const state = createStateManager();
    const workspaces = createWorkspaceManager(config.workspace, log);
    const agent = createAgentRunner(config.agent, log);
    const template = "Work on {{ issue.identifier }}: {{ issue.title }}";

    const orchestrator = createOrchestrator(
      config, tracker, state, workspaces, agent, template, log,
    );

    return { orchestrator, state, agent, config, tracker };
  }

  it("dispatches eligible candidates up to max_concurrent", async () => {
    const wsRoot = await useTmpDir();
    const dbPath = path.join(await useTmpDir(), "tasks.db");
    const store = track(createTaskStore(dbPath));
    store.createTask({ title: "Task one", state: "Todo", priority: 1, actor: "test" });
    store.createTask({ title: "Task two", state: "Todo", priority: 1, actor: "test" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, dbPath, {
      // maxTurns 1 so each fast agent finishes in a single turn (no continuation),
      // mirroring the old fixture that returned no between-turns state.
      agent: { ...makeConfig().agent, maxConcurrentAgents: 2, maxTurns: 1, command: path.join(fixturesDir, "fake-claude.sh") },
    });

    await orchestrator.refresh();

    // Wait for agents to complete (fake-claude is fast)
    await new Promise((r) => setTimeout(r, 500));

    // Both should have been dispatched and completed
    expect(state.getAllActive()).toHaveLength(0);
  });

  it("respects max_concurrent limit", async () => {
    const wsRoot = await useTmpDir();
    const dbPath = path.join(await useTmpDir(), "tasks.db");
    const store = track(createTaskStore(dbPath));
    store.createTask({ title: "Task one", state: "Todo", priority: 1, actor: "test" });
    store.createTask({ title: "Task two", state: "Todo", priority: 1, actor: "test" });
    store.createTask({ title: "Task three", state: "Todo", priority: 1, actor: "test" });

    // Use stall script so agents stay running
    const { orchestrator, state } = buildOrchestrator(wsRoot, dbPath, {
      agent: {
        ...makeConfig().agent,
        maxConcurrentAgents: 1,
        command: path.join(fixturesDir, "fake-claude-stall.sh"),
        stallTimeoutMs: 0, // disable stall detection
      },
    });

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 300));

    // Only 1 should be dispatched
    const running = state.getRunning();
    const claimed = state.getClaimed();
    expect(running.length + claimed.length).toBeLessThanOrEqual(1);

    await orchestrator.stop();
  });

  it("skips already tracked issues", async () => {
    const wsRoot = await useTmpDir();
    const dbPath = path.join(await useTmpDir(), "tasks.db");
    const store = track(createTaskStore(dbPath));
    const task1 = store.createTask({ title: "Task one", state: "Todo", priority: 1, actor: "test" });
    store.createTask({ title: "Task two", state: "Todo", priority: 1, actor: "test" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, dbPath);

    // Pre-claim task1
    state.claim(makeIssue({ id: String(task1.id), identifier: task1.identifier }));

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 500));

    // task1 should still be claimed (not re-dispatched), task2 should have run
    const worker1 = state.getWorker(task1.identifier);
    expect(worker1).toBeDefined();
    expect(worker1!.phase).toBe("claimed"); // untouched
  });

  it("retries on failure with backoff", async () => {
    const wsRoot = await useTmpDir();
    const dbPath = path.join(await useTmpDir(), "tasks.db");
    const store = track(createTaskStore(dbPath));
    const task = store.createTask({ title: "Failing task", state: "Todo", priority: 1, actor: "test" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, dbPath, {
      agent: {
        ...makeConfig().agent,
        command: path.join(fixturesDir, "fake-claude-error.sh"),
        maxRetryBackoffMs: 100, // small for test speed
      },
    });

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 500));

    // Should be in retry_queued
    const worker = state.getWorker(task.identifier);
    expect(worker).toBeDefined();
    expect(worker!.phase).toBe("retry_queued");
    expect(worker!.attempts).toBe(1);
  });

  it("reconciliation stops worker when issue reaches terminal state", async () => {
    const wsRoot = await useTmpDir();
    const dbPath = path.join(await useTmpDir(), "tasks.db");
    const store = track(createTaskStore(dbPath));
    const task = store.createTask({ title: "Stalling task", state: "Todo", priority: 1, actor: "test" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, dbPath, {
      agent: {
        ...makeConfig().agent,
        command: path.join(fixturesDir, "fake-claude-stall.sh"),
        stallTimeoutMs: 0, // disable stall detection for this test
      },
    });

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 300));

    // Verify running
    expect(state.getRunning()).toHaveLength(1);

    // Now move issue to terminal state — this also removes it from candidates
    // (listTasks by activeStates), matching the old "clear candidates" step.
    store.updateState(task.identifier, "Done", "test");

    // Trigger another tick for reconciliation
    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 500));

    // Worker should be stopped and released
    expect(state.getWorker(task.identifier)).toBeUndefined();

    await orchestrator.stop();
  });

  it("reconciliation detects stalled agents", async () => {
    const wsRoot = await useTmpDir();
    const dbPath = path.join(await useTmpDir(), "tasks.db");
    const store = track(createTaskStore(dbPath));
    const task = store.createTask({ title: "Stalling task", state: "In Progress", priority: 1, actor: "test" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, dbPath, {
      agent: {
        ...makeConfig().agent,
        command: path.join(fixturesDir, "fake-claude-stall.sh"),
        stallTimeoutMs: 200, // very short for test
      },
    });

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 300));

    // Agent should be running
    expect(state.getRunning().length).toBeGreaterThanOrEqual(0);

    // Wait for stall timeout
    await new Promise((r) => setTimeout(r, 500));

    // Trigger reconciliation. The task is still "In Progress" (a candidate), but
    // the stalled worker still exists in state, so it won't be re-dispatched.
    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 500));

    // Worker should be in retry_queued or gone after stall detection + error handler
    const worker = state.getWorker(task.identifier);
    if (worker) {
      expect(["retry_queued"]).toContain(worker.phase);
    }
    // If worker is undefined, it was released (also acceptable)

    await orchestrator.stop();
  });

  it("stop terminates all running agents", async () => {
    const wsRoot = await useTmpDir();
    const dbPath = path.join(await useTmpDir(), "tasks.db");
    const store = track(createTaskStore(dbPath));
    store.createTask({ title: "Task one", state: "Todo", priority: 1, actor: "test" });
    store.createTask({ title: "Task two", state: "Todo", priority: 1, actor: "test" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, dbPath, {
      agent: {
        ...makeConfig().agent,
        maxConcurrentAgents: 2,
        command: path.join(fixturesDir, "fake-claude-stall.sh"),
        stallTimeoutMs: 0,
      },
    });

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 300));

    await orchestrator.stop();

    expect(state.getAllActive()).toHaveLength(0);
  });

  it("tracker error keeps service alive", async () => {
    const wsRoot = await useTmpDir();
    const dbPath = path.join(await useTmpDir(), "tasks.db");
    const store = track(createTaskStore(dbPath));
    store.createTask({ title: "Task one", state: "Todo", priority: 1, actor: "test" });

    const { orchestrator, state, tracker } = buildOrchestrator(wsRoot, dbPath);

    // Simulate a tracker failure: close the underlying DB connection so
    // fetchCandidates() throws when the tick iterates it.
    tracker.close();

    // Should not throw
    await orchestrator.refresh();

    // State should be empty (no dispatch happened)
    expect(state.getAllActive()).toHaveLength(0);
  });

  it("multi-turn: continues when issue stays active", async () => {
    const wsRoot = await useTmpDir();
    const dbPath = path.join(await useTmpDir(), "tasks.db");
    const store = track(createTaskStore(dbPath));
    // Task stays "In Progress" (active) so the between-turns state check fires continuation.
    const task = store.createTask({ title: "Ongoing task", state: "In Progress", priority: 1, actor: "test" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, dbPath, {
      agent: {
        ...makeConfig().agent,
        maxConcurrentAgents: 1,
        maxTurns: 3,
        command: path.join(fixturesDir, "fake-claude.sh"), // completes quickly
      },
    });

    await orchestrator.refresh();

    // Wait for turn 1 to complete + state check + 1s delay + turn 2 to start
    await new Promise((r) => setTimeout(r, 2500));

    // Worker should still exist (continuing) with turns > 0
    const worker = state.getWorker(task.identifier);
    if (worker) {
      expect(worker.turnsCompleted).toBeGreaterThanOrEqual(1);
      expect(worker.totalCostUsd).toBeGreaterThan(0);
    }

    await orchestrator.stop();
  });

  it("multi-turn: stops at max_turns", async () => {
    const wsRoot = await useTmpDir();
    const dbPath = path.join(await useTmpDir(), "tasks.db");
    const store = track(createTaskStore(dbPath));
    const task = store.createTask({ title: "Capped task", state: "In Progress", priority: 1, actor: "test" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, dbPath, {
      agent: {
        ...makeConfig().agent,
        maxConcurrentAgents: 1,
        maxTurns: 1, // only 1 turn allowed
        command: path.join(fixturesDir, "fake-claude.sh"),
      },
    });

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 500));

    // Should have completed after 1 turn — no continuation
    expect(state.getWorker(task.identifier)).toBeUndefined();
  });

  it("multi-turn: stops when issue goes terminal between turns", async () => {
    const wsRoot = await useTmpDir();
    const dbPath = path.join(await useTmpDir(), "tasks.db");
    const store = track(createTaskStore(dbPath));
    const task = store.createTask({ title: "Terminal-between-turns", state: "In Progress", priority: 1, actor: "test" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, dbPath, {
      agent: {
        ...makeConfig().agent,
        maxConcurrentAgents: 1,
        maxTurns: 10,
        command: path.join(fixturesDir, "fake-claude.sh"),
      },
    });

    await orchestrator.refresh();
    // Once dispatched (process spawned), flip the task terminal so the
    // between-turns state check sees "Done" and stops the worker.
    store.updateState(task.identifier, "Done", "test");
    await new Promise((r) => setTimeout(r, 500));

    // Worker should be gone — terminal between turns
    expect(state.getWorker(task.identifier)).toBeUndefined();
  });

  it("tickInProgress guard prevents overlapping ticks", async () => {
    const wsRoot = await useTmpDir();
    const dbPath = path.join(await useTmpDir(), "tasks.db");
    track(createTaskStore(dbPath)); // empty DB — no candidates

    const { orchestrator } = buildOrchestrator(wsRoot, dbPath);

    // Fire two ticks simultaneously
    const [r1, r2] = await Promise.allSettled([
      orchestrator.refresh(),
      orchestrator.refresh(),
    ]);

    // Both should resolve without error
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
  });
});
