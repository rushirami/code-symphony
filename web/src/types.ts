export const STATES = ["Backlog", "Todo", "In Progress", "In Review", "Done", "Cancelled"] as const;
export type TaskState = (typeof STATES)[number];
export const BOARD_STATES: readonly TaskState[] = STATES.filter((s) => s !== "Cancelled");
export const PRIORITY_NAMES = ["none", "urgent", "high", "medium", "low"] as const;
export const TERMINAL_STATES: readonly string[] = ["Done", "Cancelled"];

export interface BlockerInfo {
  id: number;
  identifier: string;
  state: string;
}

export interface Task {
  id: number;
  identifier: string;
  title: string;
  description: string | null;
  state: string;
  priority: number;
  branchName: string | null;
  labels: string[];
  blockedBy: BlockerInfo[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskComment {
  id: number;
  taskId: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface TaskEvent {
  id: number;
  taskId: number;
  kind: string;
  oldValue: string | null;
  newValue: string | null;
  actor: string;
  note: string | null;
  createdAt: string;
}

export interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  history: TaskEvent[];
}
