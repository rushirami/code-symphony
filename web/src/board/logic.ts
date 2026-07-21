import { STATES, TERMINAL_STATES, type Task } from "../types";

/** Priority 0 = "none"; sort it after urgent(1)..low(4), matching the backend. */
export function priorityRank(p: number): number {
  return p === 0 ? 999 : p;
}

export function compareCards(a: Task, b: Task): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function groupByState(tasks: Task[], states: readonly string[]): Map<string, Task[]> {
  const groups = new Map<string, Task[]>(states.map((s) => [s, []]));
  for (const t of tasks) groups.get(t.state)?.push(t);
  for (const list of groups.values()) list.sort(compareCards);
  return groups;
}

export function isBlocked(task: Task): boolean {
  return task.blockedBy.some((b) => !TERMINAL_STATES.includes(b.state));
}

export function moveOnDrop(
  tasks: Task[],
  activeId: unknown,
  overId: unknown,
): { identifier: string; state: string } | null {
  if (typeof activeId !== "string" || typeof overId !== "string") return null;
  if (!(STATES as readonly string[]).includes(overId)) return null;
  const dragged = tasks.find((t) => t.identifier === activeId);
  if (!dragged || dragged.state === overId) return null;
  return { identifier: activeId, state: overId };
}
