import { useState } from "react";
import { Route, Routes } from "react-router";
import { Button } from "@/components/ui/button";
import { useLiveUpdates } from "./api/hooks";
import { BoardPage } from "./board/BoardPage";
import { TaskDetailPanel } from "./detail/TaskDetailPanel";
import { NewTaskModal } from "./NewTaskModal";

export default function App() {
  const connected = useLiveUpdates();
  const [showNew, setShowNew] = useState(false);
  return (
    <>
      <header className="flex items-center gap-3 border-b-4 border-border bg-main px-4 py-3">
        <h1 className="flex-1 text-xl text-main-foreground">Symphony Board</h1>
        <span
          className={`inline-block size-3 rounded-full border-2 border-border ${connected ? "bg-[#7fbc8c]" : "bg-[#ff6b6b]"}`}
          title={connected ? "Live updates connected" : "Live updates disconnected"}
        />
        <Button variant="neutral" onClick={() => setShowNew(true)}>+ New task</Button>
      </header>
      <Routes>
        <Route path="/" element={<BoardPage />}>
          <Route path="task/:identifier" element={<TaskDetailPanel />} />
        </Route>
      </Routes>
      {showNew && <NewTaskModal onClose={() => setShowNew(false)} />}
    </>
  );
}
