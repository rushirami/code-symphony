import { useState, type FormEvent } from "react";
import { useCreateTask } from "./api/hooks";
import { useToast } from "./toast";
import { PRIORITY_NAMES, STATES } from "./types";

export function NewTaskModal({ onClose }: { onClose: () => void }) {
  const create = useCreateTask();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(0);
  const [state, setState] = useState("Backlog");
  const [labels, setLabels] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    create.mutate(
      {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        state,
        labels: labels.split(",").map((s) => s.trim()).filter(Boolean),
      },
      { onSuccess: onClose, onError: (err) => toast(err.message) },
    );
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <form className="modal" onSubmit={submit}>
        <h2>New task</h2>
        <label htmlFor="nt-title">Title</label>
        <input id="nt-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor="nt-desc">Description</label>
        <textarea id="nt-desc" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="nt-priority">Priority</label>
            <select id="nt-priority" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {PRIORITY_NAMES.map((name, i) => (
                <option key={name} value={i}>{name}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="nt-state">State</label>
            <select id="nt-state" value={state} onChange={(e) => setState(e.target.value)}>
              {STATES.filter((s) => s !== "Cancelled").map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
        <label htmlFor="nt-labels">Labels</label>
        <input id="nt-labels" type="text" placeholder="comma,separated" value={labels} onChange={(e) => setLabels(e.target.value)} />
        <div className="row">
          <button className="btn primary" type="submit" disabled={create.isPending}>Create</button>
          <button className="btn" type="button" onClick={onClose}>Close</button>
        </div>
      </form>
    </>
  );
}
