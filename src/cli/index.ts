#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createTaskStore, STATES, type TaskRecord, type TaskStore } from "../db/store.js";
import { resolveDbContext, str, type Flags } from "./context.js";
import { runBoard } from "./board.js";

const PRIORITY_NAMES = ["none", "urgent", "high", "medium", "low"] as const;
const BOOLEAN_FLAGS = new Set(["all", "help"]);
const FLAG_ALIASES: Record<string, string> = { d: "description", p: "priority", l: "labels" };

// Flags every command accepts, plus --help everywhere (it just prints usage).
const COMMON_FLAGS = ["db", "author", "help"];
// Per-command additional flags (long names). Commands absent here take common only.
const COMMAND_FLAGS: Record<string, string[]> = {
  add: ["description", "priority", "labels", "state", "blocked-by", "branch"],
  list: ["state", "label", "all"],
  show: [],
  state: [],
  done: ["note"],
  cancel: ["note"],
  comment: [],
  edit: ["title", "description", "priority"],
  block: ["by"],
  unblock: ["by"],
  history: [],
  board: ["port", "actor"],
};
// Maximum positional arguments each command consumes; extras are rejected.
const MAX_POSITIONALS: Record<string, number> = {
  add: 1, list: 0, show: 1, state: 2, done: 1, cancel: 1,
  comment: 2, edit: 1, block: 1, unblock: 1, history: 1,
  board: 0,
};

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  unknownFlags: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const unknownFlags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const isLong = arg.startsWith("--") && arg.length > 2;
    const isShort = !isLong && arg.length === 2 && arg[0] === "-" && /[a-zA-Z]/.test(arg[1]);
    if (!isLong && !isShort) { positionals.push(arg); continue; }
    let name: string;
    if (isLong) {
      name = arg.slice(2);
    } else {
      const alias = FLAG_ALIASES[arg[1]];
      if (alias === undefined) {
        // Unaliased short flag (e.g. -n): record it and swallow any value so it
        // does not silently leak into positionals; validation will reject it.
        unknownFlags.push(arg);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) i++;
        continue;
      }
      name = alias;
    }
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined) throw new Error(`Flag ${isLong ? `--${name}` : arg} requires a value`);
    flags[name] = next;
    i++;
  }
  return { positionals, flags, unknownFlags };
}

// Reject any flag not recognized for the command and any excess positionals.
// Unknown commands are left to the switch's default so they report as such.
function validateArgs(command: string, parsed: ParsedArgs): void {
  const specific = COMMAND_FLAGS[command];
  if (specific === undefined) return; // unknown command: handled downstream
  for (const raw of parsed.unknownFlags) {
    throw new Error(`Unknown flag "${raw}" for command "${command}". Run: symphony help`);
  }
  const allowed = new Set([...COMMON_FLAGS, ...specific]);
  for (const name of Object.keys(parsed.flags)) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown flag "--${name}" for command "${command}". Run: symphony help`);
    }
  }
  const max = MAX_POSITIONALS[command] ?? 0;
  if (parsed.positionals.length > max) {
    throw new Error(`Unexpected argument "${parsed.positionals[max]}" for command "${command}". Run: symphony help`);
  }
}

function actorFrom(flags: ParsedArgs["flags"]): string {
  return str(flags, "author") ?? process.env.USER ?? "unknown";
}

function fmtPriority(p: number): string {
  return PRIORITY_NAMES[p] ?? String(p);
}

function requireArg(value: string | undefined, usage: string): string {
  if (!value) throw new Error(`Usage: symphony ${usage}`);
  return value;
}

function readDescription(flags: ParsedArgs["flags"]): string | undefined {
  const d = str(flags, "description");
  if (d === "-") return readFileSync(0, "utf-8");
  return d;
}

function printList(tasks: TaskRecord[]): void {
  if (tasks.length === 0) { console.log("No tasks."); return; }
  for (const t of tasks) {
    const blocked = t.blockedBy.length > 0 ? ` [blocked by ${t.blockedBy.map((b) => b.identifier).join(",")}]` : "";
    console.log(`${t.identifier.padEnd(10)} ${t.state.padEnd(12)} ${fmtPriority(t.priority).padEnd(8)} ${t.title}${blocked}`);
  }
}

function printShow(store: TaskStore, identifier: string): void {
  const t = store.getTask(identifier);
  if (!t) throw new Error(`No task with identifier "${identifier}"`);
  console.log(`${t.identifier}: ${t.title}`);
  console.log(`State: ${t.state}   Priority: ${fmtPriority(t.priority)}   Created: ${t.createdAt}`);
  if (t.labels.length) console.log(`Labels: ${t.labels.join(", ")}`);
  if (t.branchName) console.log(`Branch: ${t.branchName}`);
  if (t.blockedBy.length) console.log(`Blocked by: ${t.blockedBy.map((b) => `${b.identifier} (${b.state})`).join(", ")}`);
  if (t.description) console.log(`\n${t.description}`);
  const comments = store.getComments(identifier);
  if (comments.length) {
    console.log("\nComments:");
    for (const c of comments) console.log(`--- ${c.author} at ${c.createdAt} ---\n${c.body}`);
  }
}

function printHistory(store: TaskStore, identifier: string): void {
  for (const e of store.getHistory(identifier)) {
    const change = e.kind === "state_changed" ? ` ${e.oldValue} → ${e.newValue}`
      : e.oldValue || e.newValue ? ` ${e.oldValue ?? ""}${e.oldValue && e.newValue ? " → " : ""}${e.newValue ?? ""}`
      : "";
    console.log(`${e.createdAt}  [${e.kind}]${change}  by ${e.actor}${e.note ? `\n    ${e.note.split("\n").join("\n    ")}` : ""}`);
  }
}

const USAGE = `symphony — local task manager for claude-symphony

Usage:
  symphony add <title> [-d <markdown | - for stdin>] [-p 0-4] [-l a,b] [--state S] [--blocked-by TASK-N] [--branch NAME]
  symphony list [--state S1,S2] [--label L] [--all]
  symphony show <TASK-N>
  symphony state <TASK-N> <state>
  symphony done <TASK-N> [--note <markdown>]
  symphony cancel <TASK-N> [--note <markdown>]
  symphony comment <TASK-N> <markdown body>
  symphony edit <TASK-N> [--title T] [--description D] [-p 0-4]
  symphony block <TASK-N> --by <TASK-M>
  symphony unblock <TASK-N> --by <TASK-M>
  symphony history <TASK-N>
  symphony board [--port 4400] [--db <path>] [--actor <name>]   # web Kanban UI

Common flags: --db <path>, --author <name>
States: ${STATES.join(", ")}   Priorities: 0 none, 1 urgent, 2 high, 3 medium, 4 low
DB resolution: --db, then $SYMPHONY_DB, then tracker.db_path in nearest WORKFLOW.md, then ./tasks.db`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const parsed = parseArgs(rest);
  const { positionals, flags } = parsed;

  if (!command || command === "help" || flags.help === true) {
    console.log(USAGE);
    return;
  }

  validateArgs(command, parsed);

  if (command === "board") {
    await runBoard(flags);
    return;
  }

  const ctx = resolveDbContext(flags);
  const store = createTaskStore(ctx.dbPath, { identifierPrefix: ctx.prefix });
  const actor = actorFrom(flags);

  try {
    switch (command) {
      case "add": {
        const title = requireArg(positionals[0], 'add <title> [flags]');
        const p = str(flags, "priority");
        const task = store.createTask({
          title,
          description: readDescription(flags) ?? null,
          state: str(flags, "state"),
          priority: p !== undefined ? Number(p) : undefined,
          labels: str(flags, "labels")?.split(",").map((s) => s.trim()).filter(Boolean),
          branchName: str(flags, "branch") ?? null,
          blockedBy: str(flags, "blocked-by")?.split(",").map((s) => s.trim()).filter(Boolean),
          actor,
        });
        console.log(`Created ${task.identifier}: ${task.title} [${task.state}]`);
        break;
      }
      case "list": {
        const states = flags.all === true ? undefined
          : str(flags, "state")?.split(",").map((s) => s.trim())
            ?? STATES.filter((s) => s !== "Done" && s !== "Cancelled");
        const label = str(flags, "label");
        printList(store.listTasks({ states, labels: label ? [label] : undefined }));
        break;
      }
      case "show":
        printShow(store, requireArg(positionals[0], "show <TASK-N>"));
        break;
      case "state": {
        const id = requireArg(positionals[0], "state <TASK-N> <state>");
        const to = requireArg(positionals[1], "state <TASK-N> <state>");
        const t = store.updateState(id, to, actor);
        console.log(`${t.identifier} → ${t.state}`);
        break;
      }
      case "done":
      case "cancel": {
        const id = requireArg(positionals[0], `${command} <TASK-N> [--note ...]`);
        const t = store.updateState(id, command === "done" ? "Done" : "Cancelled", actor, str(flags, "note"));
        console.log(`${t.identifier} → ${t.state}`);
        break;
      }
      case "comment": {
        const id = requireArg(positionals[0], "comment <TASK-N> <body>");
        const body = requireArg(positionals[1], "comment <TASK-N> <body>");
        store.addComment(id, actor, body);
        console.log(`Comment added to ${id}`);
        break;
      }
      case "edit": {
        const id = requireArg(positionals[0], "edit <TASK-N> [flags]");
        const p = str(flags, "priority");
        const t = store.editTask(id, {
          title: str(flags, "title"),
          description: readDescription(flags),
          priority: p !== undefined ? Number(p) : undefined,
        }, actor);
        console.log(`Updated ${t.identifier}`);
        break;
      }
      case "block":
      case "unblock": {
        const id = requireArg(positionals[0], `${command} <TASK-N> --by <TASK-M>`);
        const by = requireArg(str(flags, "by"), `${command} <TASK-N> --by <TASK-M>`);
        if (command === "block") store.addBlocker(id, by, actor);
        else store.removeBlocker(id, by, actor);
        console.log(`${id} ${command}ed ${command === "block" ? "by" : "from"} ${by}`);
        break;
      }
      case "history":
        printHistory(store, requireArg(positionals[0], "history <TASK-N>"));
        break;
      default:
        throw new Error(`Unknown command "${command}". Run: symphony help`);
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
