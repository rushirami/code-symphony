import type {
  SymphonyConfig,
  TrackerClient,
  StateManager,
  WorkspaceManager,
  AgentRunner,
  TrackerIssue,
  Orchestrator,
  TurnResult,
} from "../types.js";
import { renderPrompt } from "../workflow/parser.js";
import type { Logger } from "pino";

export function createOrchestrator(
  initialConfig: SymphonyConfig,
  tracker: TrackerClient,
  state: StateManager,
  workspaces: WorkspaceManager,
  agent: AgentRunner,
  initialTemplate: string,
  log: Logger,
): Orchestrator {
  let config = initialConfig;
  let template = initialTemplate;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickInProgress = false;

  function availableSlots(): number {
    const used = state.getRunning().length + state.getClaimed().length;
    return Math.max(config.agent.maxConcurrentAgents - used, 0);
  }

  function stateSlotAvailable(stateName: string): boolean {
    const limit = config.agent.maxConcurrentAgentsByState[stateName.toLowerCase()];
    if (limit === undefined) return true;
    const running = state.getRunning().filter(
      (w) => w.issue.state.toLowerCase() === stateName.toLowerCase(),
    );
    const claimed = state.getClaimed().filter(
      (w) => w.issue.state.toLowerCase() === stateName.toLowerCase(),
    );
    return running.length + claimed.length < limit;
  }

  function isBlocked(issue: TrackerIssue): boolean {
    if (issue.state.toLowerCase() !== "todo") return false;
    return issue.blockedBy.some(
      (b) => !config.tracker.terminalStates.some(
        (ts) => ts.toLowerCase() === b.state.toLowerCase(),
      ),
    );
  }

  function isTerminal(stateName: string): boolean {
    return config.tracker.terminalStates.some(
      (ts) => ts.toLowerCase() === stateName.toLowerCase(),
    );
  }

  function isActive(stateName: string): boolean {
    return config.tracker.activeStates.some(
      (as) => as.toLowerCase() === stateName.toLowerCase(),
    );
  }

  function computeRetryDelay(attempts: number, isContinuation: boolean): number {
    if (isContinuation) return 1000;
    const delay = 10_000 * Math.pow(2, attempts - 1);
    return Math.min(delay, config.agent.maxRetryBackoffMs);
  }

  // ─── Dispatch: first turn for a new issue ───

  async function dispatch(issue: TrackerIssue, attempt: number | null): Promise<void> {
    const worker = state.claim(issue);
    if (attempt !== null) {
      worker.attempts = attempt;
    }

    try {
      const wsPath = await workspaces.ensure(issue);
      await workspaces.runHook("beforeRun", wsPath);

      const prompt = await renderPrompt(template, {
        issue,
        attempt: attempt,
      });

      const sessionId = worker.sessionId;

      agent.run({
        identifier: issue.identifier,
        workspacePath: wsPath,
        prompt,
        sessionId,
        turn: worker.turnsCompleted,
        onStart: (sid) => {
          state.markRunning(issue.identifier, sid);
        },
        onComplete: (result) => {
          handleTurnComplete(issue, result);
        },
        onError: (err) => {
          handleWorkerError(issue.identifier, err);
        },
      });
    } catch (err) {
      log.error({ err, issue: issue.identifier }, "Dispatch failed");
      state.release(issue.identifier);
    }
  }

  // ─── Dispatch: continuation turn (same session, minimal prompt) ───

  function dispatchContinuation(issue: TrackerIssue): void {
    const worker = state.getWorker(issue.identifier);
    if (!worker) return;

    const turn = worker.turnsCompleted;
    const maxTurns = config.agent.maxTurns;

    const prompt = `Continue working on ${issue.identifier}: ${issue.title}. This is turn ${turn + 1} of ${maxTurns}. Pick up where you left off.`;

    const wsPath = workspaces.getPath(issue.identifier);

    log.info(
      { issue: issue.identifier, turn, sessionId: worker.sessionId },
      "Dispatching continuation turn",
    );

    agent.run({
      identifier: issue.identifier,
      workspacePath: wsPath,
      prompt,
      sessionId: worker.sessionId,
      turn,
      onStart: (sid) => {
        state.markRunning(issue.identifier, sid);
      },
      onComplete: (result) => {
        handleTurnComplete(issue, result);
      },
      onError: (err) => {
        handleWorkerError(issue.identifier, err);
      },
    });
  }

  // ─── Turn completion: check state + continue or finish ───

  async function handleTurnComplete(issue: TrackerIssue, result: TurnResult): Promise<void> {
    const worker = state.getWorker(issue.identifier);
    if (!worker) return;

    // Accumulate stats
    state.accumulateTurnStats(issue.identifier, result);

    log.info(
      {
        issue: issue.identifier,
        turnsCompleted: worker.turnsCompleted,
        maxTurns: config.agent.maxTurns,
        totalCost: worker.totalCostUsd,
      },
      "Turn completed",
    );

    // Check max turns
    if (worker.turnsCompleted >= config.agent.maxTurns) {
      log.info({ issue: issue.identifier }, "Max turns reached");
      const wsPath = workspaces.getPath(issue.identifier);
      workspaces.runHook("afterRun", wsPath).catch((err) => {
        log.warn({ err, issue: issue.identifier }, "after_run hook failed");
      });
      state.markCompleted(issue.identifier);
      return;
    }

    // Check if issue is still active
    try {
      const currentStates = await tracker.fetchIssueStatesByIds([issue.id]);
      const currentState = currentStates.get(issue.id);

      if (!currentState) {
        log.info({ issue: issue.identifier }, "Could not determine issue state, completing");
        state.markCompleted(issue.identifier);
        return;
      }

      if (isTerminal(currentState)) {
        log.info(
          { issue: issue.identifier, state: currentState },
          "Issue reached terminal state between turns",
        );
        state.markCompleted(issue.identifier);
        await workspaces.remove(issue.identifier).catch((err) => {
          log.warn({ err, issue: issue.identifier }, "Workspace removal failed");
        });
        return;
      }

      if (!isActive(currentState)) {
        log.info(
          { issue: issue.identifier, state: currentState },
          "Issue no longer active between turns",
        );
        state.markCompleted(issue.identifier);
        return;
      }

      // Update issue state snapshot
      state.updateIssueState(issue.identifier, currentState);
    } catch (err) {
      log.error({ err, issue: issue.identifier }, "State check failed between turns, completing");
      state.markCompleted(issue.identifier);
      return;
    }

    // Schedule continuation: running → claimed, then re-dispatch after 1s
    state.markAwaitingContinuation(issue.identifier);

    setTimeout(() => {
      dispatchContinuation(issue);
    }, 1000);
  }

  // ─── Error handling ───

  function handleWorkerError(identifier: string, error: string): void {
    log.error({ issue: identifier, error }, "Worker failed");

    const worker = state.getWorker(identifier);
    if (!worker) return;

    // If worker is not in "running" phase (e.g., awaiting continuation), just release
    if (worker.phase !== "running") {
      state.release(identifier);
      return;
    }

    const retryDelay = computeRetryDelay(worker.attempts + 1, false);
    state.markFailed(identifier, error, config.agent.maxRetries, retryDelay);

    // Run after_run hook (non-blocking, non-aborting)
    const wsPath = workspaces.getPath(identifier);
    workspaces.runHook("afterRun", wsPath).catch((err) => {
      log.warn({ err, issue: identifier }, "after_run hook failed");
    });
  }

  // ─── Reconciliation ───

  async function reconcile(): Promise<void> {
    const running = state.getRunning();
    if (running.length === 0) return;

    // Part A: Stall detection
    if (config.agent.stallTimeoutMs > 0) {
      const now = Date.now();
      for (const worker of running) {
        const lastActivityAt = agent.getLastActivityAt(worker.issue.identifier);
        if (lastActivityAt !== null && now - lastActivityAt > config.agent.stallTimeoutMs) {
          log.warn(
            { issue: worker.issue.identifier, elapsed: now - lastActivityAt },
            "Agent stalled, terminating",
          );
          await agent.stop(worker.issue.identifier);
        }
      }
    }

    // Part B: State refresh from tracker
    const ids = state.getRunning().map((w) => w.issue.id);
    if (ids.length === 0) return;

    try {
      const currentStates = await tracker.fetchIssueStatesByIds(ids);

      for (const worker of state.getRunning()) {
        const currentState = currentStates.get(worker.issue.id);
        if (!currentState) continue;

        if (isTerminal(currentState)) {
          log.info(
            { issue: worker.issue.identifier, state: currentState },
            "Issue terminal, stopping worker",
          );
          await agent.stop(worker.issue.identifier);
          state.release(worker.issue.identifier);
          await workspaces.remove(worker.issue.identifier).catch((err) => {
            log.warn({ err, issue: worker.issue.identifier }, "Workspace removal failed");
          });
        } else if (isActive(currentState)) {
          state.updateIssueState(worker.issue.identifier, currentState);
        } else {
          log.info(
            { issue: worker.issue.identifier, state: currentState },
            "Issue no longer active, stopping worker",
          );
          await agent.stop(worker.issue.identifier);
          state.release(worker.issue.identifier);
        }
      }
    } catch (err) {
      log.error({ err }, "Reconciliation state refresh failed");
    }
  }

  // ─── Retry queue ───

  async function processRetryQueue(): Promise<void> {
    const ready = state.getRetryReady();
    for (const worker of ready) {
      if (availableSlots() <= 0) break;

      const { issue } = worker;
      const newWorker = state.reclaimForRetry(issue.identifier);
      const { attempts, sessionId, turnsCompleted } = newWorker;

      try {
        const wsPath = await workspaces.ensure(issue);
        await workspaces.runHook("beforeRun", wsPath);

        const prompt = await renderPrompt(template, {
          issue,
          attempt: attempts,
        });

        agent.run({
          identifier: issue.identifier,
          workspacePath: wsPath,
          prompt,
          sessionId,
          turn: turnsCompleted,
          onStart: (sid) => {
            state.markRunning(issue.identifier, sid);
          },
          onComplete: (result) => {
            handleTurnComplete(issue, result);
          },
          onError: (err) => {
            handleWorkerError(issue.identifier, err);
          },
        });
      } catch (err) {
        log.error({ err, issue: issue.identifier }, "Retry dispatch failed");
        state.release(issue.identifier);
      }
    }
  }

  // ─── Tick ───

  async function tick(): Promise<void> {
    if (tickInProgress) return;
    tickInProgress = true;

    try {
      await reconcile();
      await processRetryQueue();

      let slots = availableSlots();
      if (slots <= 0) {
        log.debug("No slots available, skipping dispatch");
        return;
      }

      const candidates: TrackerIssue[] = [];

      try {
        for await (const page of tracker.fetchCandidates()) {
          for (const issue of page) {
            if (state.getWorker(issue.identifier)) continue;
            if (isBlocked(issue)) continue;
            if (!stateSlotAvailable(issue.state)) continue;

            candidates.push(issue);
            if (candidates.length >= slots) break;
          }
          if (candidates.length >= slots) break;
        }
      } catch (err) {
        log.error({ err }, "Tracker fetch failed, skipping dispatch");
        return;
      }

      candidates.sort((a, b) => {
        const pa = a.priority ?? 999;
        const pb = b.priority ?? 999;
        if (pa !== pb) return pa - pb;
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.identifier.localeCompare(b.identifier);
      });

      for (const issue of candidates) {
        if (availableSlots() <= 0) break;
        await dispatch(issue, null);
      }
    } catch (err) {
      log.error({ err }, "Tick failed");
    } finally {
      tickInProgress = false;
    }
  }

  // ─── Lifecycle ───

  function start(): void {
    log.info(
      { intervalMs: config.polling.intervalMs },
      "Orchestrator starting",
    );
    tick();
    pollTimer = setInterval(() => tick(), config.polling.intervalMs);
  }

  async function stop(): Promise<void> {
    log.info("Orchestrator stopping");
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    const running = state.getRunning();
    await Promise.allSettled(
      running.map((w) => agent.stop(w.issue.identifier)),
    );

    for (const w of state.getAllActive()) {
      state.release(w.issue.identifier);
    }
  }

  async function refresh(): Promise<void> {
    await tick();
  }

  function updateConfig(newConfig: SymphonyConfig): void {
    config = newConfig;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = setInterval(() => tick(), config.polling.intervalMs);
    }
  }

  function updateTemplate(newTemplate: string): void {
    template = newTemplate;
  }

  return { start, stop, refresh, updateConfig, updateTemplate };
}
