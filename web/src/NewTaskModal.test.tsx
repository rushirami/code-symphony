import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewTaskModal } from "./NewTaskModal";

afterEach(() => vi.unstubAllGlobals());

// Radix Dialog toggles body pointer-events, which jsdom reports unreliably.
const user = () => userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });

describe("NewTaskModal", () => {
  it("creates a task and closes on success", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ identifier: "TASK-1" }), { status: 201, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <NewTaskModal onClose={onClose} />
      </QueryClientProvider>,
    );
    const u = user();
    await u.type(screen.getByLabelText("Title"), "New thing");
    await u.type(screen.getByLabelText("Labels"), "bug, infra");
    await u.click(screen.getByRole("button", { name: "Create" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ title: "New thing", state: "Backlog", priority: 0, labels: ["bug", "infra"] });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("does not submit without a title", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <NewTaskModal onClose={() => {}} />
      </QueryClientProvider>,
    );
    await user().click(screen.getByRole("button", { name: "Create" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
