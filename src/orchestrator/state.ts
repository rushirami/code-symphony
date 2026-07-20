import type {
  StateManager,
  WorkerRun,
  WorkerPhase,
  TrackerIssue,
  TurnResult,
  OrchestratorSnapshot,
} from "../types.js";

export function createStateManager(): StateManager {
  const workers = new Map<string, WorkerRun>();

  function getWorker(identifier: string): WorkerRun | undefined {
    return workers.get(identifier);
  }

  function requireWorker(identifier: string): WorkerRun {
    const w = workers.get(identifier);
    if (!w) throw new Error(`No worker for ${identifier}`);
    return w;
  }

  function assertPhase(worker: WorkerRun, expected: WorkerPhase) {
    if (worker.phase !== expected) {
      throw new Error(
        `Invalid transition: ${worker.issue.identifier} is ${worker.phase}, expected ${expected}`,
      );
    }
  }

  function claim(issue: TrackerIssue): WorkerRun {
    if (workers.has(issue.identifier)) {
      throw new Error(`Already tracked: ${issue.identifier}`);
    }
    const run: WorkerRun = {
      issue,
      phase: "claimed",
      sessionId: null,
      attempts: 0,
      turnsCompleted: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      lastError: null,
      claimedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      retryAfter: null,
      lastActivityAt: null,
    };
    workers.set(issue.identifier, run);
    return run;
  }

  function markRunning(identifier: string, sessionId: string): void {
    const w = requireWorker(identifier);
    assertPhase(w, "claimed");
    w.phase = "running";
    w.sessionId = sessionId;
    w.startedAt = Date.now();
    w.lastActivityAt = Date.now();
  }

  function markAwaitingContinuation(identifier: string): void {
    const w = requireWorker(identifier);
    assertPhase(w, "running");
    w.phase = "claimed";
  }

  function markCompleted(identifier: string): void {
    const w = requireWorker(identifier);
    w.completedAt = Date.now();
    workers.delete(identifier);
  }

  function markFailed(
    identifier: string,
    error: string,
    maxRetries: number,
    retryDelay: number,
  ): void {
    const w = requireWorker(identifier);
    assertPhase(w, "running");
    w.attempts += 1;
    w.lastError = error;

    if (w.attempts >= maxRetries) {
      workers.delete(identifier);
    } else {
      w.phase = "retry_queued";
      w.retryAfter = Date.now() + retryDelay;
    }
  }

  function accumulateTurnStats(identifier: string, result: TurnResult): void {
    const w = requireWorker(identifier);
    w.turnsCompleted += 1;
    w.totalCostUsd += result.totalCostUsd;
    w.totalDurationMs += result.durationMs;
    w.sessionId = result.sessionId;
  }

  function updateIssueState(identifier: string, state: string): void {
    const w = requireWorker(identifier);
    w.issue.state = state;
  }

  function reclaimForRetry(identifier: string): WorkerRun {
    const w = requireWorker(identifier);
    const { issue, attempts, sessionId, turnsCompleted, totalCostUsd, totalDurationMs } = w;
    workers.delete(identifier);

    const fresh: WorkerRun = {
      issue,
      phase: "claimed",
      sessionId,
      attempts,
      turnsCompleted,
      totalCostUsd,
      totalDurationMs,
      lastError: null,
      claimedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      retryAfter: null,
      lastActivityAt: null,
    };
    workers.set(issue.identifier, fresh);
    return fresh;
  }

  function release(identifier: string): void {
    workers.delete(identifier);
  }

  function byPhase(phase: WorkerPhase): WorkerRun[] {
    return [...workers.values()].filter((w) => w.phase === phase);
  }

  function getRunning(): WorkerRun[] {
    return byPhase("running");
  }

  function getClaimed(): WorkerRun[] {
    return byPhase("claimed");
  }

  function getRetryReady(): WorkerRun[] {
    const now = Date.now();
    return byPhase("retry_queued").filter(
      (w) => w.retryAfter !== null && now >= w.retryAfter,
    );
  }

  function getAllActive(): WorkerRun[] {
    return [...workers.values()];
  }

  function toSnapshot(): OrchestratorSnapshot {
    const all = [...workers.entries()].map(([identifier, w]) => ({
      ...w,
      identifier,
    }));
    const allWorkers = [...workers.values()];
    return {
      workers: all,
      runningCount: byPhase("running").length,
      claimedCount: byPhase("claimed").length,
      retryQueuedCount: byPhase("retry_queued").length,
      totalCostUsd: allWorkers.reduce((sum, w) => sum + w.totalCostUsd, 0),
      totalTurnsCompleted: allWorkers.reduce((sum, w) => sum + w.turnsCompleted, 0),
    };
  }

  return {
    claim,
    markRunning,
    markAwaitingContinuation,
    markCompleted,
    markFailed,
    release,
    accumulateTurnStats,
    updateIssueState,
    reclaimForRetry,
    getWorker,
    getRunning,
    getClaimed,
    getRetryReady,
    getAllActive,
    toSnapshot,
  };
}
