import type { StateManager, SymphonyConfig } from "../types.js";

const ESC = "\x1b";
const CLEAR = `${ESC}[2J${ESC}[H`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const CYAN = `${ESC}[36m`;
const BLUE = `${ESC}[34m`;

export interface TerminalDashboard {
  start(): void;
  stop(): void;
}

export function createTerminalDashboard(
  config: SymphonyConfig,
  state: StateManager,
  startedAt: number,
): TerminalDashboard {
  let timer: ReturnType<typeof setInterval> | null = null;

  function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function formatCost(usd: number): string {
    return `$${usd.toFixed(4)}`;
  }

  function phaseColor(phase: string): string {
    switch (phase) {
      case "running": return GREEN;
      case "claimed": return CYAN;
      case "retry_queued": return YELLOW;
      default: return DIM;
    }
  }

  function render(): void {
    const snap = state.toSnapshot();
    const uptime = formatDuration(Date.now() - startedAt);
    const lines: string[] = [];

    lines.push(CLEAR);
    lines.push(`${BOLD}${BLUE}♫ Symphony${RESET}  ${DIM}${config.tracker.projectSlug}${RESET}`);
    lines.push(`${DIM}Uptime: ${uptime}  |  Poll: ${config.polling.intervalMs / 1000}s  |  Max agents: ${config.agent.maxConcurrentAgents}${RESET}`);
    lines.push("");

    // Summary bar
    lines.push(
      `  ${GREEN}● ${snap.runningCount} running${RESET}` +
      `  ${CYAN}○ ${snap.claimedCount} claimed${RESET}` +
      `  ${YELLOW}◌ ${snap.retryQueuedCount} retrying${RESET}` +
      `  ${DIM}| ${snap.totalTurnsCompleted} turns | ${formatCost(snap.totalCostUsd)}${RESET}`,
    );
    lines.push("");

    // Workers table
    if (snap.workers.length === 0) {
      lines.push(`  ${DIM}No active workers${RESET}`);
    } else {
      lines.push(
        `  ${BOLD}${"ISSUE".padEnd(14)} ${"STATE".padEnd(14)} ${"PHASE".padEnd(14)} ${"TURNS".padEnd(8)} ${"COST".padEnd(10)} ${"ELAPSED".padEnd(10)}${RESET}`,
      );
      lines.push(`  ${DIM}${"─".repeat(70)}${RESET}`);

      for (const w of snap.workers) {
        const elapsed = w.startedAt ? formatDuration(Date.now() - w.startedAt) : "-";
        const color = phaseColor(w.phase);
        lines.push(
          `  ${w.identifier.padEnd(14)} ${w.issue.state.padEnd(14)} ${color}${w.phase.padEnd(14)}${RESET} ${String(w.turnsCompleted).padEnd(8)} ${formatCost(w.totalCostUsd).padEnd(10)} ${elapsed.padEnd(10)}`,
        );

        if (w.lastError) {
          lines.push(`  ${RED}  └ ${w.lastError.slice(0, 60)}${RESET}`);
        }
        if (w.phase === "retry_queued" && w.retryAfter) {
          const countdown = Math.max(0, Math.ceil((w.retryAfter - Date.now()) / 1000));
          lines.push(`  ${YELLOW}  └ retry in ${countdown}s${RESET}`);
        }
      }
    }

    lines.push("");
    lines.push(`${DIM}Press Ctrl+C to stop${RESET}`);

    process.stdout.write(lines.join("\n") + "\n");
  }

  return {
    start() {
      render();
      timer = setInterval(render, 1000);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
