import { useDroppable } from "@dnd-kit/core";
import { TaskCard } from "./TaskCard";
import type { Task } from "../types";

export function Column({ state, tasks }: { state: string; tasks: Task[] }) {
  const { isOver, setNodeRef } = useDroppable({ id: state });
  return (
    <section
      ref={setNodeRef}
      className={isOver ? "column drop-over" : "column"}
      aria-label={state}
    >
      <h2>
        {state} <span>{tasks.length}</span>
      </h2>
      {tasks.map((t) => (
        <TaskCard key={t.identifier} task={t} />
      ))}
    </section>
  );
}
