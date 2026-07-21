import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
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

/**
 * Like renderPanel, but serves a mutable `detail` object so the test can
 * mutate it and force a refetch (simulating a background SSE-driven
 * invalidateQueries), and exposes the QueryClient to trigger that refetch.
 */
function renderPanelWithClient(mutableDetail: TaskDetail) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/tasks") {
      return new Response(JSON.stringify([mutableDetail.task]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(mutableDetail), { status: 200, headers: { "Content-Type": "application/json" } });
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
  return { fetchMock, qc };
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
    const u = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
    await u.click(screen.getByLabelText("Priority"));
    await u.click(await screen.findByRole("option", { name: "urgent" }));
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).body).toContain('"priority":1');
  });

  it("keeps in-progress typing when a background refetch changes the task", async () => {
    const mutableDetail: TaskDetail = structuredClone(detail);
    const { qc } = renderPanelWithClient(mutableDetail);
    await screen.findByDisplayValue("Fix login");

    const titleInput = screen.getByLabelText("Title") as HTMLInputElement;
    await userEvent.type(titleInput, " EXTRA");
    expect(titleInput.value).toBe("Fix login EXTRA");

    // Simulate a concurrent update (another tab/agent) landing on the server,
    // followed by the SSE hook's blanket invalidateQueries() triggering a refetch.
    mutableDetail.task = {
      ...mutableDetail.task,
      title: "Server-renamed title",
      description: "Server-updated description",
    };

    await qc.refetchQueries({ queryKey: ["task", "TASK-1"] });

    // Non-dirty field: untouched fields should pick up the new server value.
    await waitFor(() =>
      expect(screen.getByLabelText("Description")).toHaveProperty("value", "Server-updated description"),
    );
    // Dirty field: the user's in-progress typing must survive the refetch.
    expect(titleInput.value).toBe("Fix login EXTRA");
  });
});
