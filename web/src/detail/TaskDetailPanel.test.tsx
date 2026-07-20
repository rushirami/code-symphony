import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { TaskDetailPanel } from "./TaskDetailPanel";
import type { TaskDetail } from "../types";

const detail: TaskDetail = {
  task: {
    id: 1, identifier: "TASK-1", title: "Fix login", description: "SSO broken", state: "Todo",
    priority: 2, branchName: null, labels: ["bug"], blockedBy: [],
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
  },
  comments: [
    { id: 1, taskId: 1, author: "agent", body: "working on it", createdAt: "2026-07-02T00:00:00Z" },
  ],
  history: [
    { id: 1, taskId: 1, kind: "created", oldValue: null, newValue: "Todo", actor: "rushi", note: null, createdAt: "2026-07-01T00:00:00Z" },
  ],
};

afterEach(() => vi.unstubAllGlobals());

function renderPanel() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/tasks") {
      return new Response(JSON.stringify([detail.task]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(detail), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/task/TASK-1"]}>
        <Routes>
          <Route path="/task/:identifier" element={<TaskDetailPanel />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return fetchMock;
}

describe("TaskDetailPanel", () => {
  it("shows title, description, labels, comments, and history", async () => {
    renderPanel();
    expect(await screen.findByDisplayValue("Fix login")).toBeTruthy();
    expect(screen.getByDisplayValue("SSO broken")).toBeTruthy();
    expect(screen.getByText("bug")).toBeTruthy();
    expect(screen.getByText("working on it")).toBeTruthy();
    expect(screen.getByText(/created/)).toBeTruthy();
  });

  it("submits a comment via POST", async () => {
    const fetchMock = renderPanel();
    await screen.findByDisplayValue("Fix login");
    await userEvent.type(screen.getByPlaceholderText("Add a comment…"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(call).toBeTruthy();
    expect(String(call![0])).toBe("/api/tasks/TASK-1/comments");
  });

  it("changes priority via PATCH", async () => {
    const fetchMock = renderPanel();
    await screen.findByDisplayValue("Fix login");
    await userEvent.selectOptions(screen.getByLabelText("Priority"), "1");
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).body).toContain('"priority":1');
  });
});
