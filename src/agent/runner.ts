import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentConfig, AgentEvent, AgentRunner, RunOptions, TurnResult } from "../types.js";
import type { Logger } from "pino";

export function createAgentRunner(config: AgentConfig, log: Logger): AgentRunner {
  const activeRuns = new Map<string, ChildProcess>();
  const lastActivity = new Map<string, number>();

  function buildArgs(opts: RunOptions): string[] {
    const args = [
      "-p", opts.prompt,
      "--output-format", "stream-json",
      "--verbose",
    ];

    if (config.maxTurns) {
      args.push("--max-turns", String(config.maxTurns));
    }
    if (config.allowedTools.length > 0) {
      args.push("--allowedTools", config.allowedTools.join(","));
    }
    if (config.model) {
      args.push("--model", config.model);
    }
    if (config.appendSystemPrompt) {
      args.push("--append-system-prompt", config.appendSystemPrompt);
    }
    if (config.dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    if (opts.sessionId) {
      args.push("--resume", opts.sessionId);
    }

    return args;
  }

  function handleEvent(opts: RunOptions, event: AgentEvent): void {
    lastActivity.set(opts.identifier, Date.now());

    if (event.type === "system" && "subtype" in event && event.subtype === "init") {
      log.info(
        { identifier: opts.identifier, sessionId: event.session_id },
        "Agent session started",
      );
      opts.onStart(event.session_id);
      return;
    }

    if (event.type === "assistant") {
      const text = event.message.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("");
      if (text) {
        log.debug({ identifier: opts.identifier }, "Agent: %s", text.slice(0, 200));
      }
      return;
    }

    if (event.type === "result") {
      log.info(
        {
          identifier: opts.identifier,
          turn: opts.turn,
          turns: event.num_turns,
          cost: event.total_cost_usd,
          duration: event.duration_ms,
          stopReason: event.stop_reason,
        },
        "Agent turn completed",
      );

      const result: TurnResult = {
        numTurns: event.num_turns,
        totalCostUsd: event.total_cost_usd,
        durationMs: event.duration_ms,
        sessionId: event.session_id,
      };

      if (event.is_error) {
        opts.onError(`Agent error: ${event.result}`);
      } else {
        opts.onComplete(result);
      }
    }
  }

  function run(opts: RunOptions): void {
    const args = buildArgs(opts);

    log.info(
      { identifier: opts.identifier, turn: opts.turn, command: config.command },
      "Spawning agent",
    );

    const child = spawn(config.command, args, {
      cwd: opts.workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    activeRuns.set(opts.identifier, child);
    lastActivity.set(opts.identifier, Date.now());

    // Per-issue log file
    let logStream: WriteStream | null = null;
    const logDir = path.join(opts.workspacePath, ".symphony");
    mkdir(logDir, { recursive: true })
      .then(() => {
        logStream = createWriteStream(
          path.join(logDir, `turn-${opts.turn}.ndjson`),
        );
      })
      .catch(() => {
        // Non-critical: if log dir fails, just skip logging to file
      });

    const rl = createInterface({ input: child.stdout! });
    let gotResult = false;

    rl.on("line", (line) => {
      logStream?.write(line + "\n");
      try {
        const event = JSON.parse(line) as AgentEvent;
        if (event.type === "result") gotResult = true;
        handleEvent(opts, event);
      } catch {
        // Non-JSON line (e.g. debug output), ignore
      }
    });

    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      logStream?.end();
      activeRuns.delete(opts.identifier);
      lastActivity.delete(opts.identifier);

      if (!gotResult) {
        if (code !== 0) {
          opts.onError(
            `Agent exited with code ${code}: ${stderr.slice(0, 500)}`,
          );
        } else {
          // Clean exit without result event — treat as completion
          opts.onComplete({
            numTurns: 0,
            totalCostUsd: 0,
            durationMs: 0,
            sessionId: opts.sessionId ?? "",
          });
        }
      }
    });

    child.on("error", (err) => {
      logStream?.end();
      activeRuns.delete(opts.identifier);
      lastActivity.delete(opts.identifier);
      opts.onError(`Agent spawn error: ${err.message}`);
    });
  }

  async function stop(identifier: string): Promise<void> {
    const child = activeRuns.get(identifier);
    if (!child) return;

    child.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 10_000);

      child.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // Ensure cleanup in case the close handler in run() hasn't fired yet
    activeRuns.delete(identifier);
    lastActivity.delete(identifier);
  }

  function isRunning(identifier: string): boolean {
    return activeRuns.has(identifier);
  }

  function getLastActivityAt(identifier: string): number | null {
    return lastActivity.get(identifier) ?? null;
  }

  return { run, stop, isRunning, getLastActivityAt };
}
