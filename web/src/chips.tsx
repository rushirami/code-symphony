import { PRIORITY_NAMES } from "./types";

export function PriorityChip({ priority }: { priority: number }) {
  if (priority === 0) return null;
  return <span className={`chip priority-${priority}`}>{PRIORITY_NAMES[priority] ?? priority}</span>;
}

export function LabelChip({ label }: { label: string }) {
  return <span className="chip">{label}</span>;
}
