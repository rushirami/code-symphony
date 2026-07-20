import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { BoardPage } from "./BoardPage";
import type { Task } from "../types";

const tasks: Task[] = [
  {
    id: 1, identifier: "TASK-1", title: "Fix login", description: null, state: "In Progress",
    priority: 1, branchName: null, labels: ["bug"], blockedBy: [],
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
  },
  {
    id: 2, identifier: "TASK-2", title: "Blocked one", description: null, state: "Todo",
    priority: 0, branchName: null, labels: [],
    blockedBy: [{ id: 1, identifier: "TASK-1", state: "In Progress" }],
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
  },
];

afterEach(() => vi.unstubAllGlobals());

// jsdom does not implement the PointerEvent constructor, so fireEvent.pointerDown
// (which builds a PointerEvent) silently drops clientX/clientY. Dispatch a
// MouseEvent typed as "pointerdown" instead — React's event system matches on
// the DOM event type, not the constructor, and MouseEvent honors clientX/clientY.
function firePointerDown(element: HTMLElement, { clientX, clientY }: { clientX: number; clientY: number }) {
  fireEvent(element, new MouseEvent("pointerdown", { clientX, clientY, bubbles: true, cancelable: true }));
}

function renderBoard() {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(tasks), { status: 200, headers: { "Content-Type": "application/json" } }),
  ));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route path="/task/:identifier" element={<div>DETAIL</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("BoardPage", () => {
  it("renders five columns and places cards by state", async () => {
    renderBoard();
    const inProgress = await screen.findByRole("region", { name: "In Progress" });
    expect(within(inProgress).getByText("Fix login")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Backlog" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Cancelled" })).toBeNull();
  });

  it("marks blocked tasks and shows priority chips", async () => {
    renderBoard();
    const todo = await screen.findByRole("region", { name: "Todo" });
    expect(within(todo).getByTitle(/Blocked by TASK-1/)).toBeTruthy();
    expect(screen.getByText("urgent")).toBeTruthy();
  });

  it("reveals the Cancelled column via the toggle", async () => {
    renderBoard();
    await screen.findByRole("region", { name: "Todo" });
    fireEvent.click(screen.getByLabelText("Show cancelled"));
    expect(await screen.findByRole("region", { name: "Cancelled" })).toBeTruthy();
  });

  it("does not navigate when a click follows significant pointer travel (drag tail)", async () => {
    renderBoard();
    const inProgress = await screen.findByRole("region", { name: "In Progress" });
    const card = within(inProgress).getByText("Fix login").closest(".card") as HTMLElement;
    firePointerDown(card, { clientX: 0, clientY: 0 });
    fireEvent.click(card, { clientX: 40, clientY: 0 });
    expect(screen.queryByText("DETAIL")).toBeNull();
    expect(within(inProgress).getByText("Fix login")).toBeTruthy();
  });

  it("navigates to the task detail when pointerdown and click share the same position", async () => {
    renderBoard();
    const inProgress = await screen.findByRole("region", { name: "In Progress" });
    const card = within(inProgress).getByText("Fix login").closest(".card") as HTMLElement;
    firePointerDown(card, { clientX: 10, clientY: 10 });
    fireEvent.click(card, { clientX: 10, clientY: 10 });
    expect(await screen.findByText("DETAIL")).toBeTruthy();
  });
});
