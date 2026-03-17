import { describe, it, expect } from "vitest";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { createAgentRunner } from "../src/agent/runner.js";
import { useTmpDir } from "./helpers.js";
import type { AgentConfig, TurnResult } from "../src/types.js";

const log = pino({ level: "silent" });
const fixturesDir = path.resolve(import.meta.dirname, "fixtures");

function makeAgentConfig(command: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    command,
    maxConcurrentAgents: 2,
    maxConcurrentAgentsByState: {},
    maxTurns: 5,
    maxRetries: 3,
    maxRetryBackoffMs: 10000,
    turnTimeoutMs: 60000,
    stallTimeoutMs: 5000,
    allowedTools: ["Bash", "Read"],
    dangerouslySkipPermissions: false,
    ...overrides,
  };
}

function waitForCallback(): { promise: Promise<string>; onStart: (s: string) => void; onComplete: (r: TurnResult) => void; onError: (e: string) => void; lastResult: { value: TurnResult | null } } {
  let resolve: (v: string) => void;
  const promise = new Promise<string>((r) => { resolve = r; });
  const lastResult = { value: null as TurnResult | null };
  return {
    promise,
    lastResult,
    onStart: (sessionId: string) => {},
    onComplete: (result: TurnResult) => { lastResult.value = result; resolve("complete"); },
    onError: (err: string) => resolve(`error:${err}`),
  };
}

describe("AgentRunner", () => {
  it("spawns fake-claude and parses NDJSON events", async () => {
    const wsDir = await useTmpDir();
    const runner = createAgentRunner(
      makeAgentConfig(path.join(fixturesDir, "fake-claude.sh")),
      log,
    );

    let startSessionId = "";
    const { promise, onComplete, onError } = waitForCallback();

    runner.run({
      identifier: "PROJ-1",
      workspacePath: wsDir,
      prompt: "test prompt",
      sessionId: null,
      turn: 0,
      onStart: (sid) => { startSessionId = sid; },
      onComplete,
      onError,
    });

    const result = await promise;
    expect(result).toBe("complete");
    expect(startSessionId).toBe("test-session-123");
  });

  it("calls onError on non-zero exit", async () => {
    const wsDir = await useTmpDir();
    const runner = createAgentRunner(
      makeAgentConfig(path.join(fixturesDir, "fake-claude-error.sh")),
      log,
    );

    const { promise, onStart, onComplete, onError } = waitForCallback();

    runner.run({
      identifier: "PROJ-2",
      workspacePath: wsDir,
      prompt: "test",
      sessionId: null,
      turn: 0,
      onStart,
      onComplete,
      onError,
    });

    const result = await promise;
    expect(result).toMatch(/^error:/);
    expect(result).toContain("exit");
  });

  it("calls onError when result event has is_error: true", async () => {
    const wsDir = await useTmpDir();
    const runner = createAgentRunner(
      makeAgentConfig(path.join(fixturesDir, "fake-claude-result-error.sh")),
      log,
    );

    const { promise, onStart, onComplete, onError } = waitForCallback();

    runner.run({
      identifier: "PROJ-3",
      workspacePath: wsDir,
      prompt: "test",
      sessionId: null,
      turn: 0,
      onStart,
      onComplete,
      onError,
    });

    const result = await promise;
    expect(result).toMatch(/^error:.*Out of tokens/);
  });

  it("passes correct cwd and args", async () => {
    const wsDir = await useTmpDir();
    const runner = createAgentRunner(
      makeAgentConfig(path.join(fixturesDir, "fake-claude-dump-args.sh"), {
        maxTurns: 10,
        model: "claude-sonnet-4-6",
        allowedTools: ["Bash", "Read", "Edit"],
      }),
      log,
    );

    const { promise, onStart, onComplete, onError } = waitForCallback();

    runner.run({
      identifier: "PROJ-4",
      workspacePath: wsDir,
      prompt: "do stuff",
      sessionId: null,
      turn: 0,
      onStart,
      onComplete,
      onError,
    });

    await promise;

    const args = await readFile(path.join(wsDir, ".claude-args"), "utf-8");
    const cwd = await readFile(path.join(wsDir, ".claude-cwd"), "utf-8");

    // macOS /var → /private/var symlink: compare resolved paths
    const realWsDir = await realpath(wsDir);
    expect(cwd.trim()).toBe(realWsDir);
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--max-turns");
    expect(args).toContain("10");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-6");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Bash,Read,Edit");
  });

  it("passes --resume when sessionId is provided", async () => {
    const wsDir = await useTmpDir();
    const runner = createAgentRunner(
      makeAgentConfig(path.join(fixturesDir, "fake-claude-dump-args.sh")),
      log,
    );

    const { promise, onStart, onComplete, onError } = waitForCallback();

    runner.run({
      identifier: "PROJ-5",
      workspacePath: wsDir,
      prompt: "continue work",
      sessionId: "prev-session-42",
      turn: 1,
      onStart,
      onComplete,
      onError,
    });

    await promise;

    const args = await readFile(path.join(wsDir, ".claude-args"), "utf-8");
    expect(args).toContain("--resume");
    expect(args).toContain("prev-session-42");
  });

  it("stop kills a running process", async () => {
    const wsDir = await useTmpDir();
    const runner = createAgentRunner(
      makeAgentConfig(path.join(fixturesDir, "fake-claude-stall.sh")),
      log,
    );

    let started = false;
    const { promise, onComplete, onError } = waitForCallback();

    runner.run({
      identifier: "PROJ-6",
      workspacePath: wsDir,
      prompt: "stall test",
      sessionId: null,
      turn: 0,
      onStart: () => { started = true; },
      onComplete,
      onError,
    });

    // Wait for init event
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (started) { clearInterval(check); resolve(); }
      }, 50);
    });

    expect(runner.isRunning("PROJ-6")).toBe(true);

    await runner.stop("PROJ-6");

    expect(runner.isRunning("PROJ-6")).toBe(false);
  }, 15_000);

  it("onComplete receives TurnResult with cost and session data", async () => {
    const wsDir = await useTmpDir();
    const runner = createAgentRunner(
      makeAgentConfig(path.join(fixturesDir, "fake-claude.sh")),
      log,
    );

    const { promise, onStart, onComplete, onError, lastResult } = waitForCallback();

    runner.run({
      identifier: "PROJ-8",
      workspacePath: wsDir,
      prompt: "test",
      sessionId: null,
      turn: 0,
      onStart,
      onComplete,
      onError,
    });

    await promise;
    expect(lastResult.value).not.toBeNull();
    expect(lastResult.value!.sessionId).toBe("test-session-123");
    expect(lastResult.value!.totalCostUsd).toBe(0.01);
    expect(lastResult.value!.numTurns).toBe(2);
    expect(lastResult.value!.durationMs).toBe(500);
  });

  it("writes per-issue NDJSON log file", async () => {
    const wsDir = await useTmpDir();
    const runner = createAgentRunner(
      makeAgentConfig(path.join(fixturesDir, "fake-claude.sh")),
      log,
    );

    const { promise, onStart, onComplete, onError } = waitForCallback();

    runner.run({
      identifier: "PROJ-9",
      workspacePath: wsDir,
      prompt: "test",
      sessionId: null,
      turn: 0,
      onStart,
      onComplete,
      onError,
    });

    await promise;

    // Wait a tick for log stream to flush
    await new Promise((r) => setTimeout(r, 100));

    const logContent = await readFile(path.join(wsDir, ".symphony", "turn-0.ndjson"), "utf-8");
    const lines = logContent.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2); // at least init + result

    const firstEvent = JSON.parse(lines[0]);
    expect(firstEvent.type).toBe("system");
    expect(firstEvent.subtype).toBe("init");
  });

  it("getLastActivityAt tracks event timestamps during run", async () => {
    const wsDir = await useTmpDir();
    const runner = createAgentRunner(
      makeAgentConfig(path.join(fixturesDir, "fake-claude-stall.sh")),
      log,
    );

    expect(runner.getLastActivityAt("PROJ-7")).toBeNull();

    let started = false;
    const { promise, onComplete, onError } = waitForCallback();

    runner.run({
      identifier: "PROJ-7",
      workspacePath: wsDir,
      prompt: "test",
      sessionId: null,
      turn: 0,
      onStart: () => { started = true; },
      onComplete,
      onError,
    });

    // Wait for init event
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (started) { clearInterval(check); resolve(); }
      }, 50);
    });

    // While running, lastActivity should be set
    expect(runner.getLastActivityAt("PROJ-7")).toBeTypeOf("number");

    await runner.stop("PROJ-7");

    // After stop, cleaned up
    expect(runner.getLastActivityAt("PROJ-7")).toBeNull();
  }, 15_000);
});
