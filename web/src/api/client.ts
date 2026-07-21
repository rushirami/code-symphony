import type { Task, TaskComment, TaskDetail } from "../types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : undefined),
      ...init?.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  state?: string;
  priority?: number;
  labels?: string[];
}

export const api = {
  listTasks: () => request<Task[]>("/api/tasks"),
  getTask: (id: string) => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`),
  createTask: (input: CreateTaskInput) =>
    request<Task>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  editTask: (id: string, changes: { title?: string; description?: string; priority?: number }) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) }),
  setState: (id: string, state: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}/state`, { method: "PUT", body: JSON.stringify({ state }) }),
  addComment: (id: string, body: string) =>
    request<TaskComment>(`/api/tasks/${encodeURIComponent(id)}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
  addLabel: (id: string, label: string) =>
    request<void>(`/api/tasks/${encodeURIComponent(id)}/labels/${encodeURIComponent(label)}`, { method: "PUT" }),
  removeLabel: (id: string, label: string) =>
    request<void>(`/api/tasks/${encodeURIComponent(id)}/labels/${encodeURIComponent(label)}`, { method: "DELETE" }),
  addBlocker: (id: string, blockerId: string) =>
    request<void>(`/api/tasks/${encodeURIComponent(id)}/blockers/${encodeURIComponent(blockerId)}`, { method: "PUT" }),
  removeBlocker: (id: string, blockerId: string) =>
    request<void>(`/api/tasks/${encodeURIComponent(id)}/blockers/${encodeURIComponent(blockerId)}`, { method: "DELETE" }),
};
