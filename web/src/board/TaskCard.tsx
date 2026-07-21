import { useRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useNavigate } from "react-router";
import { cn } from "@/lib/utils";
import { LabelChip, PriorityChip } from "../chips";
import { isBlocked } from "./logic";
import type { Task } from "../types";

// Clicks that follow more than this much pointer travel are the tail end of a
// drag, not an intentional click — keep in sync with the PointerSensor
// activationConstraint distance in BoardPage.tsx.
const CLICK_DRAG_THRESHOLD_PX = 5;

export function TaskCard({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.identifier,
  });
  const navigate = useNavigate();
  const downPos = useRef<{ x: number; y: number } | null>(null);
  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-card
      className={cn(
        "mb-2 cursor-grab rounded-base border-2 border-border bg-secondary-background p-2.5 text-sm transition-[box-shadow,rotate,scale,translate] duration-150",
        !isDragging && "shadow-shadow hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none",
        isDragging && "rotate-2 scale-105 shadow-[6px_6px_0_0_var(--border)]",
      )}
      onPointerDown={(e) => {
        downPos.current = { x: e.clientX, y: e.clientY };
        listeners?.onPointerDown?.(e);
      }}
      onClick={(e) => {
        const down = downPos.current;
        // A click after significant pointer travel is the tail end of a
        // drag-and-drop, not a real click — ignore it so a drop doesn't
        // also navigate to the task detail page.
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_DRAG_THRESHOLD_PX) {
          return;
        }
        navigate(`/task/${task.identifier}`);
      }}
      {...attributes}
    >
      <span className="text-xs text-black/60">{task.identifier}</span>
      {isBlocked(task) && (
        <span
          className="float-right text-xs"
          title={`Blocked by ${task.blockedBy.map((b) => b.identifier).join(", ")}`}
        >
          ⛔
        </span>
      )}
      <p className="my-1 font-heading">{task.title}</p>
      <div className="flex flex-wrap gap-1">
        <PriorityChip priority={task.priority} />
        {task.labels.map((l) => (
          <LabelChip key={l} label={l} />
        ))}
      </div>
    </div>
  );
}
