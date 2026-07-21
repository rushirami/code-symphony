import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useAddComment, useBlockerMutation, useEditTask, useLabelMutation, useMoveTask, useTask, useTasks,
} from "../api/hooks";
import { LabelChip } from "../chips";
import { useToast } from "../toast";
import { PRIORITY_NAMES } from "../types";

const PANEL =
  "fixed inset-y-0 right-0 z-20 w-[min(480px,100vw)] space-y-4 overflow-y-auto border-l-4 border-border bg-background p-4";
const BACKDROP = "fixed inset-0 z-10 bg-overlay";

/** Controlled input state that follows the server value until the user edits it. */
function useSyncedField(serverValue: string) {
  const [value, setValue] = useState(serverValue);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setValue(serverValue);
  }, [serverValue, dirty]);
  return { value, setValue: (v: string) => { setValue(v); setDirty(true); }, reset: () => setDirty(false) };
}

export function TaskDetailPanel() {
  const { identifier = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isPending, error } = useTask(identifier);
  const { data: allTasks } = useTasks();
  const edit = useEditTask(identifier);
  const move = useMoveTask();
  const comment = useAddComment(identifier);
  const label = useLabelMutation(identifier);
  const blocker = useBlockerMutation(identifier);
  const [newLabel, setNewLabel] = useState("");
  const [newBlocker, setNewBlocker] = useState("");
  const [newComment, setNewComment] = useState("");
  const titleField = useSyncedField(data?.task.title ?? "");
  const descriptionField = useSyncedField(data?.task.description ?? "");

  const close = () => void navigate("/");
  const onError = (err: Error) => toast(err.message);

  if (isPending) return <div className={PANEL}><p className="p-6 text-center">Loading…</p></div>;
  if (error || !data) {
    return (
      <div className={PANEL}>
        <p className="p-6 text-center text-[#cf222e]">{error?.message ?? "Not found"}</p>
        <Button variant="neutral" onClick={close}>Close</Button>
      </div>
    );
  }
  const { task, comments, history } = data;

  function saveTitle() {
    const trimmed = titleField.value.trim();
    if (trimmed && trimmed !== task.title) {
      edit.mutate({ title: trimmed }, { onError });
    }
    titleField.reset();
  }

  function saveDescription(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    edit.mutate({ description: descriptionField.value }, { onError });
    descriptionField.reset();
  }

  function addComment(e: FormEvent) {
    e.preventDefault();
    if (!newComment.trim()) return;
    comment.mutate(newComment.trim(), { onSuccess: () => setNewComment(""), onError });
  }

  function cancelTask() {
    if (window.confirm(`Cancel ${task.identifier}?`)) {
      move.mutate({ identifier: task.identifier, state: "Cancelled" }, { onError });
      close();
    }
  }

  return (
    <>
      <div className={BACKDROP} onClick={close} />
      <div className={PANEL}>
        <div className="flex items-center gap-2">
          <Badge variant="neutral">{task.identifier} · {task.state}</Badge>
          <span className="flex-1" />
          <Button variant="neutral" size="sm" onClick={cancelTask}>Cancel task</Button>
          <Button variant="neutral" size="icon" onClick={close} aria-label="Close">✕</Button>
        </div>

        <Input
          type="text"
          aria-label="Title"
          className="font-heading"
          value={titleField.value}
          onChange={(e) => titleField.setValue(e.target.value)}
          onBlur={saveTitle}
        />

        <form onSubmit={saveDescription} className="space-y-2">
          <Textarea
            name="description"
            aria-label="Description"
            rows={5}
            value={descriptionField.value}
            onChange={(e) => descriptionField.setValue(e.target.value)}
          />
          <Button type="submit" variant="neutral" size="sm">Save description</Button>
        </form>

        <div className="space-y-1.5">
          <Label htmlFor="priority">Priority</Label>
          <Select
            value={String(task.priority)}
            onValueChange={(v) => edit.mutate({ priority: Number(v) }, { onError })}
          >
            <SelectTrigger id="priority" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_NAMES.map((name, i) => (
                <SelectItem key={name} value={String(i)}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <h3>Labels</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {task.labels.map((l) => (
            <span key={l} className="flex items-center gap-0.5">
              <LabelChip label={l} />
              <Button
                variant="neutral"
                size="icon"
                className="size-6"
                aria-label={`Remove label ${l}`}
                onClick={() => label.mutate({ label: l, op: "remove" }, { onError })}
              >
                ×
              </Button>
            </span>
          ))}
        </div>
        <form onSubmit={(e) => {
          e.preventDefault();
          if (!newLabel.trim()) return;
          label.mutate({ label: newLabel.trim(), op: "add" }, { onSuccess: () => setNewLabel(""), onError });
        }}>
          <Input type="text" placeholder="Add label…" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
        </form>

        <h3>Blocked by</h3>
        <ul className="space-y-1 text-sm">
          {task.blockedBy.map((b) => (
            <li key={b.identifier} className="flex items-center gap-1.5">
              {b.identifier} ({b.state})
              <Button
                variant="neutral"
                size="icon"
                className="size-6"
                aria-label={`Remove blocker ${b.identifier}`}
                onClick={() => blocker.mutate({ blocker: b.identifier, op: "remove" }, { onError })}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
        <form onSubmit={(e) => {
          e.preventDefault();
          if (!newBlocker.trim()) return;
          blocker.mutate({ blocker: newBlocker.trim(), op: "add" }, { onSuccess: () => setNewBlocker(""), onError });
        }}>
          <Input
            type="text"
            list="task-ids"
            placeholder="Add blocker (TASK-N)…"
            value={newBlocker}
            onChange={(e) => setNewBlocker(e.target.value)}
          />
          <datalist id="task-ids">
            {(allTasks ?? [])
              .filter((t) => t.identifier !== task.identifier)
              .map((t) => (
                <option key={t.identifier} value={t.identifier}>{t.title}</option>
              ))}
          </datalist>
        </form>

        <h3>Comments</h3>
        {comments.map((c) => (
          <div className="rounded-base border-2 border-border bg-secondary-background p-2.5 text-sm shadow-shadow" key={c.id}>
            <div className="mb-1 text-xs text-black/60">{c.author} · {new Date(c.createdAt).toLocaleString()}</div>
            <div>{c.body}</div>
          </div>
        ))}
        <form onSubmit={addComment} className="space-y-2">
          <Textarea
            rows={3}
            placeholder="Add a comment…"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
          />
          <Button type="submit">Comment</Button>
        </form>

        <details>
          <summary className="cursor-pointer">History ({history.length})</summary>
          <ul className="mt-2 space-y-1 text-xs text-black/60">
            {history.map((ev) => (
              <li key={ev.id}>
                {new Date(ev.createdAt).toLocaleString()} — {ev.kind}
                {ev.oldValue || ev.newValue
                  ? ` ${ev.oldValue ?? ""}${ev.oldValue && ev.newValue ? " → " : ""}${ev.newValue ?? ""}`
                  : ""}{" "}
                by {ev.actor}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </>
  );
}
