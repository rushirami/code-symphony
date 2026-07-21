import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { useTmpDir } from "./helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function waitForLine(child: ChildProcess, pattern: RegExp, timeoutMs = 30_000): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}\nOutput so far:\n${buffer}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(pattern);
      if (match) {
        clearTimeout(timer);
        resolve(match);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
}

describe("symphony up CLI", () => {
  it("starts orchestrator + board against the workflow's db and shuts down cleanly", async () => {
    const dir = await useTmpDir();
    const dbPath = path.join(dir, "tasks.db");
    const wsRoot = path.join(dir, "workspaces");
    await mkdir(wsRoot, { recursive: true });
    await writeFile(path.join(dir, "WORKFLOW.md"), `---
tracker:
  kind: sqlite
  db_path: "${dbPath}"
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Cancelled"]
polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 1
  max_turns: 1
workspace:
  root: "${wsRoot}"
runner:
  command: "${path.join(repoRoot, "test/fixtures/fake-claude.sh")}"
server:
  enabled: false
---
Work on {{ issue.identifier }}
`);
    const child = spawn("npx", ["tsx", path.join(repoRoot, "src/cli/index.ts"), "up", "WORKFLOW.md", "--board-port", "0"], {
      cwd: dir,
      env: { ...process.env, SYMPHONY_NO_WEB_BUILD: "1", LOG_LEVEL: "silent" },
    });
    try {
      const match = await waitForLine(child, /Board UI at http:\/\/localhost:(\d+)/);
      const port = Number(match[1]);
      const res = await fetch(`http://localhost:${port}/api/tasks`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
      child.kill("SIGINT");
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 45_000);

  it("rejects an invalid --board-port before starting the orchestrator", async () => {
    const dir = await useTmpDir();
    const dbPath = path.join(dir, "tasks.db");
    const wsRoot = path.join(dir, "workspaces");
    await mkdir(wsRoot, { recursive: true });
    await writeFile(path.join(dir, "WORKFLOW.md"), `---
tracker:
  kind: sqlite
  db_path: "${dbPath}"
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Cancelled"]
polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 1
  max_turns: 1
workspace:
  root: "${wsRoot}"
runner:
  command: "${path.join(repoRoot, "test/fixtures/fake-claude.sh")}"
server:
  enabled: false
---
Work on {{ issue.identifier }}
`);
    const child = spawn("npx", ["tsx", path.join(repoRoot, "src/cli/index.ts"), "up", "WORKFLOW.md", "--board-port", "abc"], {
      cwd: dir,
      env: { ...process.env, SYMPHONY_NO_WEB_BUILD: "1", LOG_LEVEL: "silent" },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for exit.\nstdout: ${stdout}\nstderr: ${stderr}`)), 10_000);
        child.on("exit", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/--board-port/);
      // The orchestrator must never have started: it would log/print a board
      // or service startup line before the (never-reached) shutdown.
      expect(stdout + stderr).not.toMatch(/Board UI at/);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 15_000);
});
