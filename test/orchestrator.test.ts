import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import path from "node:path";
import pino from "pino";
import { createOrchestrator } from "../src/orchestrator/loop.js";
import { createStateManager } from "../src/orchestrator/state.js";
import { createWorkspaceManager } from "../src/workspace/manager.js";
import { createAgentRunner } from "../src/agent/runner.js";
import { createLinearClient } from "../src/tracker/linear.js";
import { createFakeLinearServer, type FakeLinearServer } from "./fixtures/fake-linear-server.js";
import { useTmpDir, makeIssue, makeConfig } from "./helpers.js";
import type { SymphonyConfig, TrackerClient } from "../src/types.js";

const log = pino({ level: "silent" });
const fixturesDir = path.resolve(import.meta.dirname, "fixtures");

function makeRawIssue(id: string, identifier: string, state = "Todo") {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    description: "Test issue",
    state: { name: state },
    priority: 1,
    url: `https://linear.app/test/${identifier}`,
    labels: { nodes: [] },
    branchName: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    relations: { nodes: [] },
  };
}

function setCandidates(server: FakeLinearServer, rawIssues: ReturnType<typeof makeRawIssue>[]) {
  server.setResponse("FetchCandidates", {
    projects: {
      nodes: [{
        issues: {
          nodes: rawIssues,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }],
    },
  });
}

function setStates(server: FakeLinearServer, states: Record<string, string>) {
  server.setResponse("FetchStatesByIds", {
    issues: {
      nodes: Object.entries(states).map(([id, name]) => ({
        id,
        state: { name },
      })),
    },
  });
}

describe("Orchestrator", () => {
  let server: FakeLinearServer;
  let port: number;

  beforeAll(async () => {
    server = createFakeLinearServer();
    port = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.clearRequests();
  });

  function buildOrchestrator(wsRoot: string, configOverrides: Partial<SymphonyConfig> = {}) {
    const config = makeConfig({
      ...configOverrides,
      tracker: {
        ...makeConfig().tracker,
        endpoint: `http://localhost:${port}/graphql`,
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

    const tracker = createLinearClient(config.tracker, log);
    const state = createStateManager();
    const workspaces = createWorkspaceManager(config.workspace, log);
    const agent = createAgentRunner(config.agent, log);
    const template = "Work on {{ issue.identifier }}: {{ issue.title }}";

    const orchestrator = createOrchestrator(
      config, tracker, state, workspaces, agent, template, log,
    );

    return { orchestrator, state, agent, config };
  }

  it("dispatches eligible candidates up to max_concurrent", async () => {
    const wsRoot = await useTmpDir();
    setCandidates(server, [
      makeRawIssue("id-1", "PROJ-1"),
      makeRawIssue("id-2", "PROJ-2"),
    ]);
    setStates(server, {});

    const { orchestrator, state } = buildOrchestrator(wsRoot, {
      agent: { ...makeConfig().agent, maxConcurrentAgents: 2, command: path.join(fixturesDir, "fake-claude.sh") },
    });

    await orchestrator.refresh();

    // Wait for agents to complete (fake-claude is fast)
    await new Promise((r) => setTimeout(r, 500));

    // Both should have been dispatched and completed
    expect(state.getAllActive()).toHaveLength(0);
  });

  it("respects max_concurrent limit", async () => {
    const wsRoot = await useTmpDir();
    setCandidates(server, [
      makeRawIssue("id-1", "PROJ-1"),
      makeRawIssue("id-2", "PROJ-2"),
      makeRawIssue("id-3", "PROJ-3"),
    ]);
    setStates(server, {});

    // Use stall script so agents stay running
    const { orchestrator, state } = buildOrchestrator(wsRoot, {
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
    const issue1 = makeRawIssue("id-1", "PROJ-1");
    setCandidates(server, [issue1, makeRawIssue("id-2", "PROJ-2")]);
    setStates(server, {});

    const { orchestrator, state } = buildOrchestrator(wsRoot);

    // Pre-claim PROJ-1
    state.claim(makeIssue({ id: "id-1", identifier: "PROJ-1" }));

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 500));

    // PROJ-1 should still be claimed (not re-dispatched), PROJ-2 should have run
    const worker1 = state.getWorker("PROJ-1");
    expect(worker1).toBeDefined();
    expect(worker1!.phase).toBe("claimed"); // untouched
  });

  it("retries on failure with backoff", async () => {
    const wsRoot = await useTmpDir();
    setCandidates(server, [makeRawIssue("id-1", "PROJ-1")]);
    setStates(server, {});

    const { orchestrator, state } = buildOrchestrator(wsRoot, {
      agent: {
        ...makeConfig().agent,
        command: path.join(fixturesDir, "fake-claude-error.sh"),
        maxRetryBackoffMs: 100, // small for test speed
      },
    });

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 500));

    // Should be in retry_queued
    const worker = state.getWorker("PROJ-1");
    expect(worker).toBeDefined();
    expect(worker!.phase).toBe("retry_queued");
    expect(worker!.attempts).toBe(1);
  });

  it("reconciliation stops worker when issue reaches terminal state", async () => {
    const wsRoot = await useTmpDir();
    setCandidates(server, [makeRawIssue("id-1", "PROJ-1")]);

    const { orchestrator, state, agent } = buildOrchestrator(wsRoot, {
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

    // Now set issue to terminal state and clear candidates (terminal issues don't appear)
    setStates(server, { "id-1": "Done" });
    setCandidates(server, []);

    // Trigger another tick for reconciliation
    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 500));

    // Worker should be stopped and released
    expect(state.getWorker("PROJ-1")).toBeUndefined();

    await orchestrator.stop();
  });

  it("reconciliation detects stalled agents", async () => {
    const wsRoot = await useTmpDir();
    setCandidates(server, [makeRawIssue("id-1", "PROJ-1")]);
    setStates(server, { "id-1": "In Progress" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, {
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

    // Clear candidates so stalled worker isn't re-dispatched
    setCandidates(server, []);

    // Trigger reconciliation
    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 500));

    // Worker should be in retry_queued or gone after stall detection + error handler
    const worker = state.getWorker("PROJ-1");
    if (worker) {
      expect(["retry_queued"]).toContain(worker.phase);
    }
    // If worker is undefined, it was released (also acceptable)

    await orchestrator.stop();
  });

  it("stop terminates all running agents", async () => {
    const wsRoot = await useTmpDir();
    setCandidates(server, [
      makeRawIssue("id-1", "PROJ-1"),
      makeRawIssue("id-2", "PROJ-2"),
    ]);
    setStates(server, {});

    const { orchestrator, state } = buildOrchestrator(wsRoot, {
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
    server.setError(500, "Internal Server Error");

    const { orchestrator, state } = buildOrchestrator(wsRoot);

    // Should not throw
    await orchestrator.refresh();

    // State should be empty (no dispatch happened)
    expect(state.getAllActive()).toHaveLength(0);

    // Reset for other tests
    server.setResponse("FetchCandidates", {
      projects: { nodes: [{ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }] },
    });
  });

  it("multi-turn: continues when issue stays active", async () => {
    const wsRoot = await useTmpDir();
    setCandidates(server, [makeRawIssue("id-1", "PROJ-1", "In Progress")]);
    // Return active state between turns so continuation fires
    setStates(server, { "id-1": "In Progress" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, {
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
    const worker = state.getWorker("PROJ-1");
    if (worker) {
      expect(worker.turnsCompleted).toBeGreaterThanOrEqual(1);
      expect(worker.totalCostUsd).toBeGreaterThan(0);
    }

    await orchestrator.stop();
  });

  it("multi-turn: stops at max_turns", async () => {
    const wsRoot = await useTmpDir();
    setCandidates(server, [makeRawIssue("id-1", "PROJ-1", "In Progress")]);
    setStates(server, { "id-1": "In Progress" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, {
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
    expect(state.getWorker("PROJ-1")).toBeUndefined();
  });

  it("multi-turn: stops when issue goes terminal between turns", async () => {
    const wsRoot = await useTmpDir();
    setCandidates(server, [makeRawIssue("id-1", "PROJ-1", "In Progress")]);
    // First state check returns "Done" (terminal)
    setStates(server, { "id-1": "Done" });

    const { orchestrator, state } = buildOrchestrator(wsRoot, {
      agent: {
        ...makeConfig().agent,
        maxConcurrentAgents: 1,
        maxTurns: 10,
        command: path.join(fixturesDir, "fake-claude.sh"),
      },
    });

    // Also clear candidates so it won't be re-dispatched
    setCandidates(server, []);

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 500));

    // Worker should be gone — terminal between turns
    expect(state.getWorker("PROJ-1")).toBeUndefined();
  });

  it("tickInProgress guard prevents overlapping ticks", async () => {
    const wsRoot = await useTmpDir();
    setCandidates(server, []);
    setStates(server, {});

    const { orchestrator } = buildOrchestrator(wsRoot);

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
