import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription className="sr-only">Create a new task</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nt-title">Title</Label>
            <Input id="nt-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nt-desc">Description</Label>
            <Textarea id="nt-desc" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="nt-priority">Priority</Label>
              <Select value={String(priority)} onValueChange={(v) => setPriority(Number(v))}>
                <SelectTrigger id="nt-priority" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_NAMES.map((name, i) => (
                    <SelectItem key={name} value={String(i)}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="nt-state">State</Label>
              <Select value={state} onValueChange={setState}>
                <SelectTrigger id="nt-state" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATES.filter((s) => s !== "Cancelled").map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nt-labels">Labels</Label>
            <Input id="nt-labels" placeholder="comma,separated" value={labels} onChange={(e) => setLabels(e.target.value)} />
          </div>
          <div className="mt-2 flex gap-2">
            <Button type="submit" disabled={create.isPending}>Create</Button>
            <Button type="button" variant="neutral" onClick={onClose}>Close</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
