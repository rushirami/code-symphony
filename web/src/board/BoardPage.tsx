import { useState } from "react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { Outlet } from "react-router";
import { useMoveTask, useTasks } from "../api/hooks";
import { useToast } from "../toast";
import { BOARD_STATES, STATES } from "../types";
import { groupByState, moveOnDrop } from "./logic";
import { Column } from "./Column";

export function BoardPage() {
  const { data: tasks, isPending, error, refetch } = useTasks();
  const [showCancelled, setShowCancelled] = useState(false);
  const move = useMoveTask();
  const toast = useToast();
  // Distance activation keeps plain clicks working for card navigation.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  if (isPending) return <p className="status">Loading…</p>;
  if (error) {
    return (
      <p className="status error">
        {error.message} <button className="btn" onClick={() => void refetch()}>Retry</button>
      </p>
    );
  }

  const states = showCancelled ? STATES : BOARD_STATES;
  const groups = groupByState(tasks, states);

  function onDragEnd(event: DragEndEvent) {
    const change = moveOnDrop(tasks ?? [], event.active.id, event.over?.id);
    if (change) move.mutate(change, { onError: (err) => toast(err.message) });
  }

  return (
    <>
      <label className="show-cancelled">
        <input
          type="checkbox"
          aria-label="Show cancelled"
          checked={showCancelled}
          onChange={(e) => setShowCancelled(e.target.checked)}
        />{" "}
        Show cancelled
      </label>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="board">
          {[...groups].map(([state, cards]) => (
            <Column key={state} state={state} tasks={cards} />
          ))}
        </div>
      </DndContext>
      <Outlet />
    </>
  );
}
