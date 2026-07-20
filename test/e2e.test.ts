import { describe, it, expect } from "vitest";
import { writeFile, readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { parseWorkflow } from "../src/workflow/parser.js";
import { loadConfig } from "../src/config/loader.js";
import { createSqliteTracker } from "../src/tracker/sqlite.js";
import { createTaskStore } from "../src/db/store.js";
import { createStateManager } from "../src/orchestrator/state.js";
import { createOrchestrator } from "../src/orchestrator/loop.js";
import { createWorkspaceManager } from "../src/workspace/manager.js";
import { createAgentRunner } from "../src/agent/runner.js";
import { createStatusServer } from "../src/server/status.js";
import { useTmpDir, makeConfig } from "./helpers.js";

const log = pino({ level: "silent" });
const fixturesDir = path.resolve(import.meta.dirname, "fixtures");

describe("End-to-end", () => {
  it("happy path: dispatch, run agent, complete", async () => {
    const tmpDir = await useTmpDir();
    const wsRoot = path.join(tmpDir, "workspaces");
    await mkdir(wsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, "tasks.db");

    // Seed the task the orchestrator will dispatch.
    const store = createTaskStore(dbPath);
    const task = store.createTask({
      title: "Login is broken",
      description: "Users cannot log in",
      state: "Todo",
      priority: 1,
      labels: ["bug"],
      branchName: "fix-login",
      actor: "test",
    });

    // Write WORKFLOW.md (max_turns 1 → single-turn completion, no continuation)
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    await writeFile(workflowPath, `---
tracker:
  kind: sqlite
  db_path: "${dbPath}"
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Cancelled"]
polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 2
  max_turns: 1
  max_retries: 3
workspace:
  root: "${wsRoot}"
runner:
  command: "${path.join(fixturesDir, "fake-claude-dump-args.sh")}"
---
You are working on {{ issue.identifier }}: {{ issue.title }}

Description: {{ issue.description }}
Labels: {% for label in issue.labels %}{{ label }} {% endfor %}
`, "utf-8");

    // Parse and load
    const workflow = await parseWorkflow(workflowPath);
    const config = loadConfig(workflow.config);

    // Wire up
    const tracker = createSqliteTracker(config.tracker, log);
    const state = createStateManager();
    const workspaces = createWorkspaceManager(config.workspace, log);
    const agent = createAgentRunner(config.agent, log);
    const orchestrator = createOrchestrator(
      config, tracker, state, workspaces, agent, workflow.templateBody, log,
    );

    // Run one tick
    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 500));

    // Verify workspace was created
    const wsPath = workspaces.getPath(task.identifier);
    const s = await stat(wsPath);
    expect(s.isDirectory()).toBe(true);

    // Verify the prompt was passed correctly
    const argsFile = path.join(wsPath, ".claude-args");
    const args = await readFile(argsFile, "utf-8");
    expect(args).toContain(task.identifier);
    expect(args).toContain("Login is broken");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");

    // Verify the agent completed (state should be empty)
    expect(state.getAllActive()).toHaveLength(0);

    await orchestrator.stop();
    tracker.close();
    store.close();
  });

  it("full stack with status server", async () => {
    const tmpDir = await useTmpDir();
    const wsRoot = path.join(tmpDir, "workspaces");
    await mkdir(wsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, "tasks.db");

    const store = createTaskStore(dbPath);
    const task = store.createTask({ title: "Fix the widget", state: "Todo", priority: 1, actor: "test" });

    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    await writeFile(workflowPath, `---
tracker:
  kind: sqlite
  db_path: "${dbPath}"
  active_states: ["Todo"]
  terminal_states: ["Done"]
polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 1
workspace:
  root: "${wsRoot}"
runner:
  command: "${path.join(fixturesDir, "fake-claude-stall.sh")}"
server:
  port: 0
  enabled: true
---
Work on {{ issue.identifier }}
`, "utf-8");

    const workflow = await parseWorkflow(workflowPath);
    const config = loadConfig(workflow.config);

    const tracker = createSqliteTracker(config.tracker, log);
    const state = createStateManager();
    const workspaces = createWorkspaceManager(config.workspace, log);
    const agent = createAgentRunner({ ...config.agent, stallTimeoutMs: 0 }, log);
    const orchestrator = createOrchestrator(
      { ...config, agent: { ...config.agent, stallTimeoutMs: 0 } },
      tracker, state, workspaces, agent, workflow.templateBody, log,
    );

    const statusServer = createStatusServer(config.server, state, orchestrator, log);
    await statusServer.start();
    const serverUrl = `http://localhost:${statusServer.port}`;

    // Dispatch
    await orchestrator.refresh();

    // Poll until worker reaches running state (avoids flaky fixed timeout)
    let stateBody: { runningCount: number };
    const deadline = Date.now() + 5000;
    do {
      await new Promise((r) => setTimeout(r, 100));
      const stateRes = await fetch(`${serverUrl}/api/v1/state`);
      stateBody = await stateRes.json() as { runningCount: number };
    } while (stateBody.runningCount === 0 && Date.now() < deadline);

    expect(stateBody.runningCount).toBe(1);

    const issueRes = await fetch(`${serverUrl}/api/v1/${task.identifier}`);
    expect(issueRes.status).toBe(200);
    const issueBody = await issueRes.json();
    expect(issueBody.phase).toBe("running");

    // Trigger refresh via API
    const refreshRes = await fetch(`${serverUrl}/api/v1/refresh`, { method: "POST" });
    expect(refreshRes.status).toBe(202);

    // Cleanup
    await orchestrator.stop();
    await statusServer.stop();
    tracker.close();
    store.close();
  });

  it("hot reload: changing WORKFLOW.md updates the template", async () => {
    const tmpDir = await useTmpDir();
    const wsRoot = path.join(tmpDir, "workspaces");
    await mkdir(wsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, "tasks.db");

    const store = createTaskStore(dbPath);
    // Seed only the first task up front; the second is added mid-test (like the
    // old fixture swapping the candidate response between dispatches).
    const task1 = store.createTask({ title: "First task", state: "Todo", priority: 1, actor: "test" });

    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    await writeFile(workflowPath, `---
tracker:
  kind: sqlite
  db_path: "${dbPath}"
  active_states: ["Todo"]
  terminal_states: ["Done"]
polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 2
  max_turns: 1
workspace:
  root: "${wsRoot}"
runner:
  command: "${path.join(fixturesDir, "fake-claude-dump-args.sh")}"
---
Original prompt for {{ issue.identifier }}
`, "utf-8");

    const workflow = await parseWorkflow(workflowPath);
    const config = loadConfig(workflow.config);

    const tracker = createSqliteTracker(config.tracker, log);
    const state = createStateManager();
    const workspaces = createWorkspaceManager(config.workspace, log);
    const agent = createAgentRunner(config.agent, log);
    const orchestrator = createOrchestrator(
      config, tracker, state, workspaces, agent, workflow.templateBody, log,
    );

    // First dispatch with original prompt
    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 300));

    const wsPath1 = workspaces.getPath(task1.identifier);
    const args1 = await readFile(path.join(wsPath1, ".claude-args"), "utf-8");
    expect(args1).toContain(`Original prompt for ${task1.identifier}`);

    // Close out the first task so it isn't a candidate on the next tick.
    store.updateState(task1.identifier, "Done", "test");

    // Update template via orchestrator (simulating hot reload)
    orchestrator.updateTemplate("Updated prompt for {{ issue.identifier }}");

    // Dispatch a new issue with updated template
    const task2 = store.createTask({ title: "Second task", state: "Todo", priority: 1, actor: "test" });

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 300));

    const wsPath2 = workspaces.getPath(task2.identifier);
    const args2 = await readFile(path.join(wsPath2, ".claude-args"), "utf-8");
    expect(args2).toContain(`Updated prompt for ${task2.identifier}`);

    await orchestrator.stop();
    tracker.close();
    store.close();
  });

  it("multi-turn e2e: dispatches continuation with --resume", async () => {
    const tmpDir = await useTmpDir();
    const wsRoot = path.join(tmpDir, "workspaces");
    await mkdir(wsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, "tasks.db");

    const store = createTaskStore(dbPath);
    // Task stays "In Progress" (active) so the between-turns check triggers continuation.
    const task = store.createTask({ title: "Ongoing work", state: "In Progress", priority: 1, actor: "test" });

    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    await writeFile(workflowPath, `---
tracker:
  kind: sqlite
  db_path: "${dbPath}"
  active_states: ["In Progress"]
  terminal_states: ["Done"]
polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 1
  max_turns: 3
workspace:
  root: "${wsRoot}"
runner:
  command: "${path.join(fixturesDir, "fake-claude-dump-args.sh")}"
---
Full prompt for {{ issue.identifier }}
`, "utf-8");

    const workflow = await parseWorkflow(workflowPath);
    const config = loadConfig(workflow.config);
    const tracker = createSqliteTracker(config.tracker, log);
    const state = createStateManager();
    const workspaces = createWorkspaceManager(config.workspace, log);
    const agent = createAgentRunner(config.agent, log);
    const orchestrator = createOrchestrator(
      config, tracker, state, workspaces, agent, workflow.templateBody, log,
    );

    await orchestrator.refresh();

    // Wait for turn 0 + state check + 1s delay + turn 1 to complete
    await new Promise((r) => setTimeout(r, 2500));

    const wsPath = workspaces.getPath(task.identifier);

    // Turn 0 log should exist
    const turn0Log = await readFile(path.join(wsPath, ".symphony", "turn-0.ndjson"), "utf-8");
    expect(turn0Log).toContain('"type":"system"');

    // The latest .claude-args is from the continuation turn — should have --resume
    // since continuation dispatches pass sessionId.
    const latestArgs = await readFile(path.join(wsPath, ".claude-args"), "utf-8");
    expect(latestArgs).toContain("--resume");
    expect(latestArgs).toContain(`Continue working on ${task.identifier}`);

    // Token tracking should show accumulated cost
    const worker = state.getWorker(task.identifier);
    if (worker) {
      expect(worker.turnsCompleted).toBeGreaterThanOrEqual(1);
      expect(worker.totalCostUsd).toBeGreaterThan(0);
    }

    await orchestrator.stop();
    tracker.close();
    store.close();
  });

  it("agent closes its task via the CLI; reconciliation releases the worker", async () => {
    const tmpDir = await useTmpDir();
    const dbPath = path.join(tmpDir, "tasks.db");
    const store = createTaskStore(dbPath);
    const task = store.createTask({ title: "Close me", state: "Todo", actor: "test" });

    const config = makeConfig({
      tracker: { ...makeConfig().tracker, dbPath },
      workspace: { root: path.join(tmpDir, "ws"), hooks: { timeoutMs: 5000 } },
      agent: {
        ...makeConfig().agent,
        command: path.join(fixturesDir, "fake-claude-done.sh"),
        maxTurns: 5,
        env: {
          SYMPHONY_DB: dbPath,
          SYMPHONY_REPO: path.resolve(import.meta.dirname, ".."),
          SYMPHONY_TASK: task.identifier,
        },
      },
    });
    const tracker = createSqliteTracker(config.tracker, log);
    const state = createStateManager();
    const workspaces = createWorkspaceManager(config.workspace, log);
    const agent = createAgentRunner(config.agent, log);
    const orchestrator = createOrchestrator(
      config, tracker, state, workspaces, agent, "Work on {{ issue.identifier }}", log,
    );

    await orchestrator.refresh(); // dispatch

    // Poll for the fake agent (spawns npx tsx — cold start can be slow) to close the task.
    let closed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (store.getTask(task.identifier)!.state === "Done") { closed = true; break; }
    }
    expect(closed).toBe(true);
    expect(store.getTask(task.identifier)!.state).toBe("Done");
    expect(store.getComments(task.identifier)[0].body).toBe("Completed by fake agent");

    await orchestrator.refresh(); // reconciliation sees terminal state
    expect(state.toSnapshot().workers.filter((w) => w.phase !== "released")).toHaveLength(0);

    await orchestrator.stop();
    tracker.close();
    store.close();
  }, 20_000);
});
