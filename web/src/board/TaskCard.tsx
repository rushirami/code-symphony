import { useDraggable } from "@dnd-kit/core";
import { useNavigate } from "react-router";
import { LabelChip, PriorityChip } from "../chips";
import { isBlocked } from "./logic";
import type { Task } from "../types";

export function TaskCard({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.identifier,
  });
  const navigate = useNavigate();
  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={isDragging ? "card dragging" : "card"}
      onClick={() => navigate(`/task/${task.identifier}`)}
      {...listeners}
      {...attributes}
    >
      <span className="card-id">{task.identifier}</span>
      {isBlocked(task) && (
        <span
          className="badge-blocked"
          title={`Blocked by ${task.blockedBy.map((b) => b.identifier).join(", ")}`}
        >
          ⛔
        </span>
      )}
      <p className="card-title">{task.title}</p>
      <div className="card-chips">
        <PriorityChip priority={task.priority} />
        {task.labels.map((l) => (
          <LabelChip key={l} label={l} />
        ))}
      </div>
    </div>
  );
}
