import { useDroppable } from "@dnd-kit/core";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { stateAccentClass } from "./accents";
import { TaskCard } from "./TaskCard";
import type { Task } from "../types";

export function Column({ state, tasks }: { state: string; tasks: Task[] }) {
  const { isOver, setNodeRef } = useDroppable({ id: state });
  return (
    <section
      ref={setNodeRef}
      aria-label={state}
      className={cn(
        "w-72 shrink-0 rounded-base border-2 border-border bg-secondary-background p-2 transition-colors duration-150",
        stateAccentClass(state),
        isOver && "border-4 bg-main/25 p-[6px]",
      )}
    >
      <h2 className="mb-2 flex items-center justify-between rounded-base border-2 border-border bg-main px-2 py-1.5 text-xs tracking-wide text-main-foreground uppercase shadow-shadow">
        {state} <Badge variant="neutral">{tasks.length}</Badge>
      </h2>
      {tasks.map((t) => (
        <TaskCard key={t.identifier} task={t} />
      ))}
    </section>
  );
}
