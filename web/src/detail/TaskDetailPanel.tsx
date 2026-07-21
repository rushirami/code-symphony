import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import {
  useAddComment, useBlockerMutation, useEditTask, useLabelMutation, useMoveTask, useTask, useTasks,
} from "../api/hooks";
import { LabelChip } from "../chips";
import { useToast } from "../toast";
import { PRIORITY_NAMES } from "../types";

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

  if (isPending) return <div className="panel"><p className="status">Loading…</p></div>;
  if (error || !data) {
    return (
      <div className="panel">
        <p className="status error">{error?.message ?? "Not found"}</p>
        <button className="btn" onClick={close}>Close</button>
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
      <div className="panel-backdrop" onClick={close} />
      <div className="panel">
        <div className="row">
          <span className="card-id">{task.identifier} · {task.state}</span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={cancelTask}>Cancel task</button>
          <button className="btn" onClick={close} aria-label="Close">✕</button>
        </div>

        <input
          type="text"
          aria-label="Title"
          value={titleField.value}
          onChange={(e) => titleField.setValue(e.target.value)}
          onBlur={saveTitle}
        />

        <form onSubmit={saveDescription}>
          <textarea
            name="description"
            aria-label="Description"
            rows={5}
            value={descriptionField.value}
            onChange={(e) => descriptionField.setValue(e.target.value)}
          />
          <button className="btn" type="submit">Save description</button>
        </form>

        <label htmlFor="priority">Priority</label>
        <select
          id="priority"
          value={task.priority}
          onChange={(e) => edit.mutate({ priority: Number(e.target.value) }, { onError })}
        >
          {PRIORITY_NAMES.map((name, i) => (
            <option key={name} value={i}>{name}</option>
          ))}
        </select>

        <h3>Labels</h3>
        <div className="card-chips">
          {task.labels.map((l) => (
            <span key={l}>
              <LabelChip label={l} />
              <button
                className="btn"
                aria-label={`Remove label ${l}`}
                onClick={() => label.mutate({ label: l, op: "remove" }, { onError })}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <form onSubmit={(e) => {
          e.preventDefault();
          if (!newLabel.trim()) return;
          label.mutate({ label: newLabel.trim(), op: "add" }, { onSuccess: () => setNewLabel(""), onError });
        }}>
          <input type="text" placeholder="Add label…" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
        </form>

        <h3>Blocked by</h3>
        <ul>
          {task.blockedBy.map((b) => (
            <li key={b.identifier}>
              {b.identifier} ({b.state}){" "}
              <button
                className="btn"
                aria-label={`Remove blocker ${b.identifier}`}
                onClick={() => blocker.mutate({ blocker: b.identifier, op: "remove" }, { onError })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={(e) => {
          e.preventDefault();
          if (!newBlocker.trim()) return;
          blocker.mutate({ blocker: newBlocker.trim(), op: "add" }, { onSuccess: () => setNewBlocker(""), onError });
        }}>
          <input
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
          <div className="comment" key={c.id}>
            <div className="meta">{c.author} · {new Date(c.createdAt).toLocaleString()}</div>
            <div>{c.body}</div>
          </div>
        ))}
        <form onSubmit={addComment}>
          <textarea
            rows={3}
            placeholder="Add a comment…"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
          />
          <button className="btn primary" type="submit">Comment</button>
        </form>

        <details>
          <summary>History ({history.length})</summary>
          <ul className="history">
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
