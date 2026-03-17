import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { parseWorkflow, renderPrompt } from "../src/workflow/parser.js";
import { loadConfig } from "../src/config/loader.js";
import { createLinearClient } from "../src/tracker/linear.js";
import { createStateManager } from "../src/orchestrator/state.js";
import { createOrchestrator } from "../src/orchestrator/loop.js";
import { createWorkspaceManager } from "../src/workspace/manager.js";
import { createAgentRunner } from "../src/agent/runner.js";
import { createStatusServer } from "../src/server/status.js";
import { createFakeLinearServer, type FakeLinearServer } from "./fixtures/fake-linear-server.js";
import { useTmpDir } from "./helpers.js";

const log = pino({ level: "silent" });
const fixturesDir = path.resolve(import.meta.dirname, "fixtures");

function makeRawIssue(id: string, identifier: string, state = "Todo") {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    description: `Description for ${identifier}`,
    state: { name: state },
    priority: 1,
    url: `https://linear.app/test/${identifier}`,
    labels: { nodes: [{ name: "bug" }] },
    branchName: `fix-${identifier.toLowerCase()}`,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    relations: { nodes: [] },
  };
}

describe("End-to-end", () => {
  let linearServer: FakeLinearServer;
  let linearPort: number;

  beforeAll(async () => {
    linearServer = createFakeLinearServer();
    linearPort = await linearServer.start();
  });

  afterAll(async () => {
    await linearServer.stop();
  });

  it("happy path: dispatch, run agent, complete", async () => {
    const tmpDir = await useTmpDir();
    const wsRoot = path.join(tmpDir, "workspaces");
    await mkdir(wsRoot, { recursive: true });

    // Write WORKFLOW.md
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    await writeFile(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: test-proj
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Cancelled"]
  endpoint: http://localhost:${linearPort}/graphql
polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 2
  max_turns: 5
  max_retries: 3
workspace:
  root: "${wsRoot}"
codex:
  command: "${path.join(fixturesDir, "fake-claude-dump-args.sh")}"
---
You are working on {{ issue.identifier }}: {{ issue.title }}

Description: {{ issue.description }}
Labels: {% for label in issue.labels %}{{ label }} {% endfor %}
`, "utf-8");

    // Set up fake Linear
    linearServer.setResponse("FetchCandidates", {
      projects: {
        nodes: [{
          issues: {
            nodes: [makeRawIssue("id-1", "PROJ-1")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }],
      },
    });
    linearServer.setResponse("FetchStatesByIds", {
      issues: { nodes: [] },
    });

    // Parse and load
    const workflow = await parseWorkflow(workflowPath);
    const config = loadConfig(workflow.config);

    // Wire up
    const tracker = createLinearClient(config.tracker, log);
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
    const wsPath = workspaces.getPath("PROJ-1");
    const s = await stat(wsPath);
    expect(s.isDirectory()).toBe(true);

    // Verify the prompt was passed correctly
    const argsFile = path.join(wsPath, ".claude-args");
    const args = await readFile(argsFile, "utf-8");
    expect(args).toContain("PROJ-1");
    expect(args).toContain("Issue PROJ-1");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");

    // Verify the agent completed (state should be empty)
    expect(state.getAllActive()).toHaveLength(0);

    await orchestrator.stop();
  });

  it("full stack with status server", async () => {
    const tmpDir = await useTmpDir();
    const wsRoot = path.join(tmpDir, "workspaces");
    await mkdir(wsRoot, { recursive: true });

    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    await writeFile(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: test-proj
  active_states: ["Todo"]
  terminal_states: ["Done"]
  endpoint: http://localhost:${linearPort}/graphql
polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 1
workspace:
  root: "${wsRoot}"
codex:
  command: "${path.join(fixturesDir, "fake-claude-stall.sh")}"
server:
  port: 0
  enabled: true
---
Work on {{ issue.identifier }}
`, "utf-8");

    linearServer.setResponse("FetchCandidates", {
      projects: {
        nodes: [{
          issues: {
            nodes: [makeRawIssue("id-1", "PROJ-1")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }],
      },
    });
    linearServer.setResponse("FetchStatesByIds", {
      issues: { nodes: [{ id: "id-1", state: { name: "Todo" } }] },
    });

    const workflow = await parseWorkflow(workflowPath);
    const config = loadConfig(workflow.config);

    const tracker = createLinearClient(config.tracker, log);
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
    await new Promise((r) => setTimeout(r, 300));

    // Check status API
    const stateRes = await fetch(`${serverUrl}/api/v1/state`);
    const stateBody = await stateRes.json();
    expect(stateBody.runningCount).toBe(1);

    const issueRes = await fetch(`${serverUrl}/api/v1/PROJ-1`);
    expect(issueRes.status).toBe(200);
    const issueBody = await issueRes.json();
    expect(issueBody.phase).toBe("running");

    // Trigger refresh via API
    const refreshRes = await fetch(`${serverUrl}/api/v1/refresh`, { method: "POST" });
    expect(refreshRes.status).toBe(202);

    // Cleanup
    await orchestrator.stop();
    await statusServer.stop();
  });

  it("hot reload: changing WORKFLOW.md updates the template", async () => {
    const tmpDir = await useTmpDir();
    const wsRoot = path.join(tmpDir, "workspaces");
    await mkdir(wsRoot, { recursive: true });

    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    await writeFile(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: test-proj
  active_states: ["Todo"]
  terminal_states: ["Done"]
  endpoint: http://localhost:${linearPort}/graphql
polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 2
workspace:
  root: "${wsRoot}"
codex:
  command: "${path.join(fixturesDir, "fake-claude-dump-args.sh")}"
---
Original prompt for {{ issue.identifier }}
`, "utf-8");

    const workflow = await parseWorkflow(workflowPath);
    const config = loadConfig(workflow.config);

    const tracker = createLinearClient(config.tracker, log);
    const state = createStateManager();
    const workspaces = createWorkspaceManager(config.workspace, log);
    const agent = createAgentRunner(config.agent, log);
    const orchestrator = createOrchestrator(
      config, tracker, state, workspaces, agent, workflow.templateBody, log,
    );

    // First dispatch with original prompt
    linearServer.setResponse("FetchCandidates", {
      projects: {
        nodes: [{
          issues: {
            nodes: [makeRawIssue("id-1", "PROJ-1")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }],
      },
    });
    linearServer.setResponse("FetchStatesByIds", { issues: { nodes: [] } });

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 300));

    const wsPath1 = workspaces.getPath("PROJ-1");
    const args1 = await readFile(path.join(wsPath1, ".claude-args"), "utf-8");
    expect(args1).toContain("Original prompt for PROJ-1");

    // Update template via orchestrator (simulating hot reload)
    orchestrator.updateTemplate("Updated prompt for {{ issue.identifier }}");

    // Dispatch a new issue with updated template
    linearServer.setResponse("FetchCandidates", {
      projects: {
        nodes: [{
          issues: {
            nodes: [makeRawIssue("id-2", "PROJ-2")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }],
      },
    });

    await orchestrator.refresh();
    await new Promise((r) => setTimeout(r, 300));

    const wsPath2 = workspaces.getPath("PROJ-2");
    const args2 = await readFile(path.join(wsPath2, ".claude-args"), "utf-8");
    expect(args2).toContain("Updated prompt for PROJ-2");

    await orchestrator.stop();
  });

  it("multi-turn e2e: dispatches continuation with --resume", async () => {
    const tmpDir = await useTmpDir();
    const wsRoot = path.join(tmpDir, "workspaces");
    await mkdir(wsRoot, { recursive: true });

    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    await writeFile(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: test-proj
  active_states: ["In Progress"]
  terminal_states: ["Done"]
  endpoint: http://localhost:${linearPort}/graphql
polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 1
  max_turns: 3
workspace:
  root: "${wsRoot}"
codex:
  command: "${path.join(fixturesDir, "fake-claude-dump-args.sh")}"
---
Full prompt for {{ issue.identifier }}
`, "utf-8");

    // Return issue as active so continuation fires
    linearServer.setResponse("FetchCandidates", {
      projects: {
        nodes: [{
          issues: {
            nodes: [makeRawIssue("id-1", "PROJ-1", "In Progress")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }],
      },
    });
    linearServer.setResponse("FetchStatesByIds", {
      issues: { nodes: [{ id: "id-1", state: { name: "In Progress" } }] },
    });

    const workflow = await parseWorkflow(workflowPath);
    const config = loadConfig(workflow.config);
    const tracker = createLinearClient(config.tracker, log);
    const state = createStateManager();
    const workspaces = createWorkspaceManager(config.workspace, log);
    const agent = createAgentRunner(config.agent, log);
    const orchestrator = createOrchestrator(
      config, tracker, state, workspaces, agent, workflow.templateBody, log,
    );

    await orchestrator.refresh();

    // Wait for turn 0 + state check + 1s delay + turn 1 to complete
    await new Promise((r) => setTimeout(r, 2500));

    const wsPath = workspaces.getPath("PROJ-1");

    // Turn 0 log should exist
    const turn0Log = await readFile(path.join(wsPath, ".symphony", "turn-0.ndjson"), "utf-8");
    expect(turn0Log).toContain('"type":"system"');

    // Turn 0 args should have the full prompt (no --resume)
    const turn0Args = await readFile(path.join(wsPath, ".claude-args"), "utf-8");
    // The latest .claude-args is from the most recent turn — should have --resume
    // since continuation dispatches pass sessionId
    expect(turn0Args).toContain("--resume");
    expect(turn0Args).toContain("Continue working on PROJ-1");

    // Token tracking should show accumulated cost
    const worker = state.getWorker("PROJ-1");
    if (worker) {
      expect(worker.turnsCompleted).toBeGreaterThanOrEqual(1);
      expect(worker.totalCostUsd).toBeGreaterThan(0);
    }

    await orchestrator.stop();
  });
});
