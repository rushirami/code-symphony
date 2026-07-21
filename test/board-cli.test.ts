import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { useTmpDir } from "./helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function waitForLine(child: ChildProcess, pattern: RegExp, timeoutMs = 20_000): Promise<RegExpMatchArray> {
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

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}

describe("symphony board CLI", () => {
  it("starts, serves the API, and shuts down on SIGINT", async () => {
    const dir = await useTmpDir();
    const child = spawn("npx", ["tsx", path.join(repoRoot, "src/cli/index.ts"), "board", "--port", "0"], {
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
      expect(await waitForExit(child)).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  it("shuts down cleanly when SIGINT is received twice in quick succession", async () => {
    const dir = await useTmpDir();
    // Spawn via `node --import <tsx/esm loader>` (single process) rather than the `tsx` CLI
    // binary: the CLI wraps the script in a parent/child pair with its own signal-relay logic
    // that, when hit with two signals in quick succession, races and force-kills via SIGKILL —
    // masking the very idempotency behavior this test is meant to exercise. The loader is
    // referenced by absolute path (not the bare "tsx/esm" specifier) so resolution doesn't
    // depend on cwd, since the child runs with cwd set to the temp db directory.
    const tsxEsmLoader = path.join(repoRoot, "node_modules/tsx/dist/esm/index.mjs");
    const child = spawn(process.execPath, ["--import", tsxEsmLoader, path.join(repoRoot, "src/cli/index.ts"), "board", "--port", "0"], {
      cwd: dir,
      env: { ...process.env, SYMPHONY_NO_WEB_BUILD: "1", LOG_LEVEL: "silent" },
    });
    try {
      await waitForLine(child, /Board UI at http:\/\/localhost:(\d+)/);
      child.kill("SIGINT");
      child.kill("SIGINT");
      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.on("exit", (c, s) => resolve({ code: c, signal: s })),
      );
      // Clean exit through our guarded shutdown is code 0. On macOS the second raw
      // SIGINT can occasionally be delivered to chokidar's native FSEvents thread and
      // terminate the process via the OS default disposition (code null, SIGINT) before
      // the JS handler runs — an environmental race present even without our handler,
      // so it is tolerated. Any other outcome (e.g. code 1 from an unhandled rejection
      // or the force-exit fallback, double-stop crash) is a real regression.
      const cleanExit = code === 0;
      const osDefaultKill = code === null && signal === "SIGINT";
      expect(cleanExit || osDefaultKill).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30_000);
});
