import { useState } from "react";
import { Route, Routes } from "react-router";
import { useLiveUpdates } from "./api/hooks";
import { BoardPage } from "./board/BoardPage";
import { TaskDetailPanel } from "./detail/TaskDetailPanel";
import { NewTaskModal } from "./NewTaskModal";

export default function App() {
  const connected = useLiveUpdates();
  const [showNew, setShowNew] = useState(false);
  return (
    <>
      <header className="topbar">
        <h1>Symphony Board</h1>
        <span
          className={connected ? "dot on" : "dot off"}
          title={connected ? "Live updates connected" : "Live updates disconnected"}
        />
        <button className="btn primary" onClick={() => setShowNew(true)}>+ New task</button>
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
