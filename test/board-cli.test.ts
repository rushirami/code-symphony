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
});
