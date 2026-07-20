import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CreateTaskInput } from "./client";
import type { Task } from "../types";

export function useTasks() {
  return useQuery({ queryKey: ["tasks"], queryFn: api.listTasks });
}

export function useTask(identifier: string) {
  return useQuery({
    queryKey: ["task", identifier],
    queryFn: () => api.getTask(identifier),
    enabled: identifier.length > 0,
  });
}

export function useMoveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ identifier, state }: { identifier: string; state: string }) =>
      api.setState(identifier, state),
    onMutate: async ({ identifier, state }) => {
      await qc.cancelQueries({ queryKey: ["tasks"] });
      const previous = qc.getQueryData<Task[]>(["tasks"]);
      qc.setQueryData<Task[]>(["tasks"], (tasks) =>
        tasks?.map((t) => (t.identifier === identifier ? { ...t, state } : t)),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(["tasks"], ctx.previous);
    },
    onSettled: () => qc.invalidateQueries(),
  });
}

function useInvalidatingMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries() });
}

export function useCreateTask() {
  return useInvalidatingMutation((input: CreateTaskInput) => api.createTask(input));
}

export function useEditTask(identifier: string) {
  return useInvalidatingMutation(
    (changes: { title?: string; description?: string; priority?: number }) =>
      api.editTask(identifier, changes),
  );
}

export function useAddComment(identifier: string) {
  return useInvalidatingMutation((body: string) => api.addComment(identifier, body));
}

export function useLabelMutation(identifier: string) {
  return useInvalidatingMutation(({ label, op }: { label: string; op: "add" | "remove" }) =>
    op === "add" ? api.addLabel(identifier, label) : api.removeLabel(identifier, label),
  );
}

export function useBlockerMutation(identifier: string) {
  return useInvalidatingMutation(({ blocker, op }: { blocker: string; op: "add" | "remove" }) =>
    op === "add" ? api.addBlocker(identifier, blocker) : api.removeBlocker(identifier, blocker),
  );
}

/** Opens one SSE connection; invalidates all queries on every change ping. */
export function useLiveUpdates(): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => {
      setConnected(true);
      void qc.invalidateQueries(); // catch anything missed while disconnected
    };
    es.onerror = () => setConnected(false);
    es.addEventListener("changed", () => void qc.invalidateQueries());
    return () => es.close();
  }, [qc]);
  return connected;
}
