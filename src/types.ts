// ─── Config ───

export interface TrackerConfig {
  kind: "linear";
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  activeStates: string[];
  terminalStates: string[];
}

export interface PollingConfig {
  intervalMs: number;
}

export interface AgentConfig {
  command: string;
  maxConcurrentAgents: number;
  maxConcurrentAgentsByState: Record<string, number>;
  maxTurns: number;
  maxRetries: number;
  maxRetryBackoffMs: number;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  model?: string;
  allowedTools: string[];
  appendSystemPrompt?: string;
  dangerouslySkipPermissions: boolean;
}

export interface WorkspaceConfig {
  root: string;
  hooks: HooksConfig;
}

export interface HooksConfig {
  afterCreate?: string;
  beforeRun?: string;
  afterRun?: string;
  beforeRemove?: string;
  timeoutMs: number;
}

export interface ServerConfig {
  port: number;
  enabled: boolean;
  dashboard: boolean;
}

export interface SymphonyConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  agent: AgentConfig;
  workspace: WorkspaceConfig;
  server: ServerConfig;
}

// ─── Tracker (Linear) ───

export interface BlockerRef {
  id: string;
  identifier: string;
  state: string;
}

export interface TrackerIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: string;
  priority: number | null;
  url: string;
  labels: string[];
  branchName: string | null;
  blockedBy: BlockerRef[];
  createdAt: string;
  updatedAt: string;
}

// ─── Orchestrator State Machine ───

export type WorkerPhase =
  | "claimed"
  | "running"
  | "retry_queued"
  | "released";

export interface WorkerRun {
  issue: TrackerIssue;
  phase: WorkerPhase;
  sessionId: string | null;
  attempts: number;
  turnsCompleted: number;
  totalCostUsd: number;
  totalDurationMs: number;
  lastError: string | null;
  claimedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  retryAfter: number | null;
  lastActivityAt: number | null;
}

export interface TurnResult {
  numTurns: number;
  totalCostUsd: number;
  durationMs: number;
  sessionId: string;
}

// ─── Agent Events (Claude CLI NDJSON) ───

export interface AgentInitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
}

export interface AgentAssistantEvent {
  type: "assistant";
  message: {
    content: Array<{ type: string; text?: string }>;
    stop_reason: string | null;
  };
  session_id: string;
}

export interface AgentResultEvent {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  result: string;
  session_id: string;
  num_turns: number;
  total_cost_usd: number;
  duration_ms: number;
  stop_reason: string;
}

export type AgentEvent = AgentInitEvent | AgentAssistantEvent | AgentResultEvent;

// ─── Workflow ───

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  templateBody: string;
}

// ─── Agent Runner ───

export interface RunOptions {
  identifier: string;
  workspacePath: string;
  prompt: string;
  sessionId: string | null;
  turn: number;
  onStart: (sessionId: string) => void;
  onComplete: (result: TurnResult) => void;
  onError: (error: string) => void;
}

export interface AgentRunner {
  run(options: RunOptions): void;
  stop(identifier: string): Promise<void>;
  isRunning(identifier: string): boolean;
  getLastActivityAt(identifier: string): number | null;
}

// ─── Workspace Manager ───

export interface WorkspaceManager {
  ensure(issue: TrackerIssue): Promise<string>;
  remove(identifier: string): Promise<void>;
  getPath(identifier: string): string;
  runHook(hookName: "beforeRun" | "afterRun", cwd: string): Promise<void>;
}

// ─── Tracker Client ───

export interface TrackerClient {
  fetchCandidates(): AsyncGenerator<TrackerIssue[], void, unknown>;
  fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>>;
  fetchIssuesByStates(states: string[]): Promise<TrackerIssue[]>;
}

// ─── State Manager ───

export interface OrchestratorSnapshot {
  workers: Array<WorkerRun & { identifier: string }>;
  runningCount: number;
  claimedCount: number;
  retryQueuedCount: number;
  totalCostUsd: number;
  totalTurnsCompleted: number;
}

export interface StateManager {
  claim(issue: TrackerIssue): WorkerRun;
  markRunning(identifier: string, sessionId: string): void;
  markAwaitingContinuation(identifier: string): void;
  markCompleted(identifier: string): void;
  markFailed(identifier: string, error: string, maxRetries: number, retryDelay: number): void;
  release(identifier: string): void;
  accumulateTurnStats(identifier: string, result: TurnResult): void;
  updateIssueState(identifier: string, state: string): void;
  reclaimForRetry(identifier: string): WorkerRun;
  getWorker(identifier: string): WorkerRun | undefined;
  getRunning(): WorkerRun[];
  getClaimed(): WorkerRun[];
  getRetryReady(): WorkerRun[];
  getAllActive(): WorkerRun[];
  toSnapshot(): OrchestratorSnapshot;
}

// ─── Orchestrator ───

export interface Orchestrator {
  start(): void;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  updateConfig(config: SymphonyConfig): void;
  updateTemplate(template: string): void;
}
