import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PRIORITY_NAMES } from "./types";

// Fixed palette — priority colors must read the same in every column,
// so they don't inherit the column's --main accent.
const PRIORITY_BG: Record<number, string> = {
  1: "bg-[#ff6b6b]",
  2: "bg-[#fd9745]",
  3: "bg-[#ffdc58]",
  4: "bg-[#e4e4e7]",
};

export function PriorityChip({ priority }: { priority: number }) {
  if (priority === 0) return null;
  return (
    <Badge className={cn("text-black", PRIORITY_BG[priority])}>
      {PRIORITY_NAMES[priority] ?? priority}
    </Badge>
  );
}

export function LabelChip({ label }: { label: string }) {
  return <Badge variant="neutral">{label}</Badge>;
}
