/**
 * Smoke test: starts a fake Linear server, writes a WORKFLOW.md,
 * and runs the full Symphony service for a few seconds.
 *
 * Usage: npx tsx test/smoke.ts
 */
import { createFakeLinearServer } from "./fixtures/fake-linear-server.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const TMP_DIR = "/tmp/symphony-smoke-test";
const WS_ROOT = path.join(TMP_DIR, "workspaces");
const WORKFLOW = path.join(TMP_DIR, "WORKFLOW.md");
const FAKE_CLAUDE = path.resolve(import.meta.dirname, "fixtures/fake-claude.sh");

async function main() {
  // Clean up from previous runs
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(WS_ROOT, { recursive: true });

  // 1. Start fake Linear server
  const server = createFakeLinearServer();
  const port = await server.start();
  console.log(`[smoke] Fake Linear server on port ${port}`);

  server.setResponse("FetchCandidates", {
    projects: {
      nodes: [{
        issues: {
          nodes: [
            {
              id: "smoke-1",
              identifier: "SMOKE-1",
              title: "Fix the widget",
              description: "The widget is broken",
              state: { name: "Todo" },
              priority: 1,
              url: "https://linear.app/test/SMOKE-1",
              labels: { nodes: [{ name: "bug" }] },
              branchName: "smoke-1-fix-widget",
              createdAt: "2026-03-01T00:00:00.000Z",
              updatedAt: "2026-03-10T00:00:00.000Z",
              relations: { nodes: [] },
            },
            {
              id: "smoke-2",
              identifier: "SMOKE-2",
              title: "Add dark mode",
              description: "Users want dark mode",
              state: { name: "Todo" },
              priority: 2,
              url: "https://linear.app/test/SMOKE-2",
              labels: { nodes: [{ name: "feature" }] },
              branchName: "smoke-2-dark-mode",
              createdAt: "2026-03-02T00:00:00.000Z",
              updatedAt: "2026-03-11T00:00:00.000Z",
              relations: { nodes: [] },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }],
    },
  });

  server.setResponse("FetchStatesByIds", {
    issues: { nodes: [] },
  });

  server.setResponse("FetchIssuesByStates", {
    projects: { nodes: [{ issues: { nodes: [] } }] },
  });

  // 2. Write WORKFLOW.md
  await writeFile(WORKFLOW, `---
tracker:
  kind: linear
  api_key: fake-key-for-smoke-test
  project_slug: smoke-proj
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Cancelled"]
  endpoint: http://localhost:${port}/graphql
polling:
  interval_ms: 5000
agent:
  max_concurrent_agents: 2
  max_turns: 3
workspace:
  root: "${WS_ROOT}"
codex:
  command: "${FAKE_CLAUDE}"
server:
  port: 0
  enabled: true
---
You are working on {{ issue.identifier }}: {{ issue.title }}

## Description
{{ issue.description }}

## Labels
{% for label in issue.labels %}- {{ label }}
{% endfor %}
`, "utf-8");

  console.log(`[smoke] WORKFLOW.md written to ${WORKFLOW}`);

  // 3. Run Symphony as a subprocess
  console.log(`[smoke] Starting Symphony...`);
  const symphony = spawn("npx", ["tsx", "src/index.ts", WORKFLOW], {
    cwd: path.resolve(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOG_LEVEL: "info", NODE_ENV: "development" },
  });

  const rl = createInterface({ input: symphony.stdout! });
  const lines: string[] = [];

  rl.on("line", (line) => {
    console.log(`  [symphony] ${line}`);
    lines.push(line);
  });

  symphony.stderr!.on("data", (chunk: Buffer) => {
    console.error(`  [symphony:err] ${chunk.toString().trim()}`);
  });

  // 4. Wait for it to run for a few seconds
  console.log(`[smoke] Waiting 4 seconds for dispatches...`);
  await new Promise((r) => setTimeout(r, 4000));

  // 5. Verify: check that workspaces were created
  const { readdirSync } = await import("node:fs");
  const dirs = readdirSync(WS_ROOT);
  console.log(`[smoke] Workspaces created: ${dirs.join(", ") || "(none)"}`);

  if (dirs.length >= 1) {
    console.log(`[smoke] ✅ At least one workspace created`);
  } else {
    console.log(`[smoke] ❌ No workspaces created`);
  }

  // 6. Graceful shutdown
  console.log(`[smoke] Sending SIGTERM...`);
  symphony.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    symphony.on("close", (code) => {
      console.log(`[smoke] Symphony exited with code ${code}`);
      resolve();
    });
    // Failsafe
    setTimeout(() => {
      symphony.kill("SIGKILL");
      resolve();
    }, 5000);
  });

  await server.stop();

  // Cleanup
  await rm(TMP_DIR, { recursive: true, force: true });

  console.log(`\n[smoke] ✅ Smoke test complete. ${lines.length} log lines captured.`);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
