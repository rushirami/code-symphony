import { Route, Routes } from "react-router";
import { useLiveUpdates } from "./api/hooks";
import { BoardPage } from "./board/BoardPage";
import { TaskDetailPanel } from "./detail/TaskDetailPanel";

export default function App() {
  const connected = useLiveUpdates();
  return (
    <>
      <header className="topbar">
        <h1>Symphony Board</h1>
        <span
          className={connected ? "dot on" : "dot off"}
          title={connected ? "Live updates connected" : "Live updates disconnected"}
        />
      </header>
      <Routes>
        <Route path="/" element={<BoardPage />}>
          <Route path="task/:identifier" element={<TaskDetailPanel />} />
        </Route>
      </Routes>
    </>
  );
}
