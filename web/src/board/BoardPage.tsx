import { useState } from "react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { Outlet } from "react-router";
import { Button } from "@/components/ui/button";
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

  if (isPending) return <p className="p-6 text-center">Loading…</p>;
  if (error) {
    return (
      <div className="mx-auto mt-8 flex w-fit items-center gap-3 rounded-base border-2 border-border bg-[#ff6b6b] px-6 py-4 shadow-shadow">
        {error.message}
        <Button variant="neutral" size="sm" onClick={() => void refetch()}>Retry</Button>
      </div>
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
      <label className="block px-4 pt-3 text-sm">
        <input
          type="checkbox"
          aria-label="Show cancelled"
          checked={showCancelled}
          onChange={(e) => setShowCancelled(e.target.checked)}
        />{" "}
        Show cancelled
      </label>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="flex min-h-[calc(100vh-64px)] items-start gap-4 overflow-x-auto p-4">
          {[...groups].map(([state, cards]) => (
            <Column key={state} state={state} tasks={cards} />
          ))}
        </div>
      </DndContext>
      <Outlet />
    </>
  );
}
