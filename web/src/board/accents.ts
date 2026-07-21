const ACCENTS: Record<string, string> = {
  Backlog: "accent-backlog",
  Todo: "accent-todo",
  "In Progress": "accent-inprogress",
  "In Review": "accent-inreview",
  Done: "accent-done",
  Cancelled: "accent-cancelled",
};

/** CSS class scoping the column's `--main` accent; "" for unknown states. */
export function stateAccentClass(state: string): string {
  return ACCENTS[state] ?? "";
}
