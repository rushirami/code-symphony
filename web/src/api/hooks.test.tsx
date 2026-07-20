import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMoveTask } from "./hooks";
import type { Task } from "../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1, identifier: "TASK-1", title: "A", description: null, state: "Backlog",
    priority: 0, branchName: null, labels: [], blockedBy: [],
    createdAt: "2026-07-20T00:00:00Z", updatedAt: "2026-07-20T00:00:00Z",
    ...overrides,
  };
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(["tasks"], [makeTask()]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

afterEach(() => vi.unstubAllGlobals());

describe("useMoveTask", () => {
  it("applies the move optimistically before the server responds", async () => {
    const { qc, wrapper } = setup();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {}))); // never resolves
    const { result } = renderHook(() => useMoveTask(), { wrapper });
    result.current.mutate({ identifier: "TASK-1", state: "Todo" });
    await waitFor(() => {
      const tasks = qc.getQueryData<Task[]>(["tasks"])!;
      expect(tasks[0].state).toBe("Todo");
    });
  });

  it("rolls back on server error", async () => {
    const { qc, wrapper } = setup();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Unknown state" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    const { result } = renderHook(() => useMoveTask(), { wrapper });
    result.current.mutate({ identifier: "TASK-1", state: "Nope" });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("Unknown state");
    expect(qc.getQueryData<Task[]>(["tasks"])![0].state).toBe("Backlog");
  });
});
