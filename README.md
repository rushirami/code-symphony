# Claude Symphony

A long-running automation service that polls a local SQLite task database (`tasks.db`) for tasks, dispatches them to isolated workspaces, and runs [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a coding agent per task. Based on the [OpenAI Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md), adapted to use Claude Code instead of Codex, with a self-contained local task manager instead of an external tracker.

Symphony is a **scheduler/runner** — it reads from the task database but never writes to it directly. The coding agent (Claude Code) updates task state itself, via the bundled `symphony` CLI.

## Architecture

```
┌─────────────┐     poll      ┌─────────────┐
│  tasks.db   │◄──────────────│ Orchestrator │
│  (SQLite)   │   SQL query   │   (loop.ts)  │
└─────────────┘               └──────┬───────┘
                                     │ dispatch
                              ┌──────▼───────┐
                              │    State      │
                              │   Machine     │
                              │  (state.ts)   │
                              └──────┬───────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
             ┌──────────┐    ┌──────────┐    ┌──────────┐
             │Workspace │    │  Agent   │    │  Status  │
             │ Manager  │    │  Runner  │    │  Server  │
             │(manager) │    │(runner)  │    │(status)  │
             └──────────┘    └──────────┘    └──────────┘
                  │               │
                  │          claude -p
                  │          --output-format
                  ▼          stream-json
             /tmp/symphony_     │
             workspaces/        ▼
             ├── task-1/   ┌──────────┐
             └── task-2/   │ Claude   │
                           │ Code CLI │
                           └──────────┘
```

## How it works

1. **Poll** — Fetches tasks from `tasks.db` in configured active states (e.g. "Todo", "In Progress")
2. **Dispatch** — Claims eligible tasks, creates isolated workspace directories, renders a Liquid prompt template
3. **Run** — Spawns `claude -p` as a child process per task with `--output-format stream-json`, parses NDJSON events
4. **Continue** — After each turn, checks if the task is still active and `turnsCompleted < maxTurns`. If so, re-dispatches with `--resume <sessionId>` after a 1s delay using a short continuation prompt (the full prompt was only sent on turn 1)
5. **Reconcile** — Each tick checks running agents for stalls, refreshes task states from `tasks.db`, stops agents for terminal tasks
6. **Retry** — Failed agents get exponential backoff retries (`min(10s * 2^n, max_backoff)`)
7. **Observe** — Structured Pino logging + optional HTTP status API + optional terminal dashboard

## Components

| Module | File | Purpose |
|--------|------|---------|
| **Types** | `src/types.ts` | All shared interfaces (zero runtime) |
| **Logger** | `src/logger.ts` | Pino structured logging (pretty in dev, JSON in prod) |
| **Config Schema** | `src/config/schema.ts` | Zod schemas with `$ENV_VAR` resolution |
| **Config Loader** | `src/config/loader.ts` | Merges defaults + env + WORKFLOW.md frontmatter |
| **Workflow Parser** | `src/workflow/parser.ts` | gray-matter (YAML frontmatter) + liquidjs (strict mode templates) |
| **DB Schema** | `src/db/schema.ts` | SQLite DDL (tasks, labels, relations, comments, events) + `user_version` migration guard |
| **Task Store** | `src/db/store.ts` | CRUD, state transitions, blocking relations, append-only history — all in transactions |
| **SQLite Tracker** | `src/tracker/sqlite.ts` | `TrackerClient` implementation backed by the local `TaskStore` (no network) |
| **State Machine** | `src/orchestrator/state.ts` | In-memory worker states: claimed → running → retry_queued → released |
| **Orchestrator** | `src/orchestrator/loop.ts` | Poll-dispatch loop, concurrency control, reconciliation, retry backoff |
| **Workspace Manager** | `src/workspace/manager.ts` | Per-issue directories, path sanitization, lifecycle hooks |
| **Agent Runner** | `src/agent/runner.ts` | Spawns Claude CLI, parses NDJSON stream, session management, per-issue log files |
| **Status Server** | `src/server/status.ts` | Optional HTTP API (`GET /api/v1/state`, `GET /api/v1/:id`, `POST /api/v1/refresh`) |
| **Dashboard** | `src/dashboard/terminal.ts` | Optional ANSI terminal dashboard with live worker status, turn counts, and costs |
| **Task CLI** | `src/cli/index.ts` | `symphony` command — the agent's interface for reading and writing tasks in `tasks.db` |
| **Entry Point** | `src/index.ts` | Composition root, chokidar file watcher for hot-reload, graceful shutdown |

## Setup

```bash
npm install
npm run build && npm link
```

Requires Node.js >= 20 and `claude` CLI installed. `npm link` puts the `symphony` command on your `PATH`, which the dispatched Claude Code agents need in order to update their own tasks (see [Task management CLI](#task-management-cli) below).

## Configuration

All configuration lives in a `WORKFLOW.md` file — YAML frontmatter for settings, Markdown body for the prompt template:

```markdown
---
tracker:
  kind: sqlite
  db_path: ./tasks.db
  identifier_prefix: TASK
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Cancelled"]
polling:
  interval_ms: 30000
agent:
  max_concurrent_agents: 10
  max_turns: 20
  max_retries: 3
  max_retry_backoff_ms: 300000
workspace:
  root: /tmp/symphony_workspaces
  hooks:
    after_create: |
      git clone $REPO_URL .
runner:
  command: claude
server:
  port: 8080
  enabled: true
  dashboard: true
---
You are working on {{ issue.identifier }}: {{ issue.title }}

## Description
{{ issue.description }}

## Instructions
1. Read the codebase
2. Implement the changes
3. Write tests
4. Commit with a descriptive message
5. When the work is complete, run: `symphony done {{ issue.identifier }} --note "<markdown summary of what you did>"`
6. If you are blocked, run: `symphony comment {{ issue.identifier }} "<what is blocking you>"` then `symphony state {{ issue.identifier }} "In Review"`
```

Environment variables are resolved via `$VAR` or `${VAR}` syntax. The prompt template uses [Liquid](https://liquidjs.com/) with strict mode — undefined variables/filters cause errors. `db_path` is resolved relative to the `WORKFLOW.md` file's directory, and the orchestrator injects it into every dispatched agent as `SYMPHONY_DB` so the `symphony` CLI finds the same database with no extra flags.

## Task management CLI

`symphony` is a small CLI backed directly by `tasks.db` — it's how both you and dispatched agents create, inspect, and close out tasks. It's the only supported way to mutate the task database (the orchestrator itself only reads).

```bash
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
```

Common flags: `--db <path>`, `--author <name>`. States: `Backlog, Todo, In Progress, In Review, Done, Cancelled`. Priorities: `0` none, `1` urgent, `2` high, `3` medium, `4` low.

**DB resolution order** — the CLI picks the first of:

1. `--db <path>`
2. `$SYMPHONY_DB` environment variable
3. `tracker.db_path` from the nearest `WORKFLOW.md` (searched upward from the current directory)
4. `./tasks.db`

This is what lets a dispatched agent just run `symphony done TASK-12 --note "..."` from inside its workspace — the orchestrator sets `SYMPHONY_DB` for it — while a human at the repo root can run the same commands and land on the same database via the `WORKFLOW.md` fallback.

Run `symphony help` (or `npm run build && node dist/cli/index.js help`) to print this usage text from the built CLI.

## Usage

```bash
# Run with default WORKFLOW.md in current directory
npm start

# Run with a specific workflow file
npx tsx src/index.ts /path/to/WORKFLOW.md

# Set log level
LOG_LEVEL=debug npm start
```

The service runs continuously, polling `tasks.db` every `interval_ms`. Modify `WORKFLOW.md` while running — changes are hot-reloaded without restart. Send `SIGINT` or `SIGTERM` for graceful shutdown.

## Status API

When `server.enabled: true`, the HTTP API provides:

- `GET /api/v1/state` — Full orchestrator snapshot (all workers, turn counts, cumulative cost)
- `GET /api/v1/TASK-123` — Single worker details (turns completed, session ID, cost)
- `POST /api/v1/refresh` — Trigger immediate poll cycle

## Terminal Dashboard

When `server.dashboard: true`, Symphony renders a live ANSI terminal display refreshing every second:

```
♫ Symphony  tasks.db
Uptime: 5m 23s  |  Poll: 30s  |  Max agents: 10

  ● 2 running  ○ 0 claimed  ◌ 1 retrying  | 14 turns | $0.4200

  ISSUE          STATE          PHASE          TURNS    COST       ELAPSED
  ──────────────────────────────────────────────────────────────────────────
  TASK-1         In Progress    running        5        $0.2100    3m 12s
  TASK-2         Todo           running        3        $0.1500    1m 45s
  TASK-3         In Progress    retry_queued   2        $0.0600    -
    └ retry in 8s
```

## Tests

```bash
npm test              # run all tests
npx vitest            # watch mode
npx tsx test/smoke.ts # end-to-end smoke test with a real tasks.db + fake Claude
```

**104 tests** across 11 files, all end-to-end with no mocks:

- **Fake Claude scripts** (`test/fixtures/fake-claude*.sh`) — Real shell scripts emitting NDJSON, testing the actual spawn + parse pipeline
- **Real SQLite databases** (temp `.db` files via `better-sqlite3`) for store, tracker, and CLI tests — no mocked persistence layer
- **Real filesystem** for workspace tests (temp directories)
- **Full integration** tests wiring all components together, including the `symphony` CLI itself (`test/cli.test.ts`)

## Per-issue log files

Each agent turn writes its full NDJSON stream to the workspace at `.symphony/turn-N.ndjson`. This lets you replay exactly what the agent did:

```
workspaces/task-1/.symphony/
├── turn-0.ndjson   # First turn (full prompt)
├── turn-1.ndjson   # Continuation turn
└── turn-2.ndjson   # Another continuation
```

## Key design decisions

- **Multi-turn continuation loop** — After each turn, checks task state in `tasks.db` and re-dispatches with `--resume` if still active (up to `max_turns`)
- **Turn 1 gets full prompt, turns 2+ get minimal** — "Continue working on TASK-1. Pick up where you left off." Since `--resume` preserves conversation history, the full prompt would be redundant
- **Claude Code CLI** instead of Codex JSON-RPC — uses `claude -p --output-format stream-json --verbose` for structured output
- **Token/cost tracking** — Accumulates `total_cost_usd` and `duration_ms` across all turns per worker, exposed in snapshot API and dashboard
- **SQLite as source of truth** — worker state is in-memory only; `tasks.db` is authoritative and is re-read from scratch on restart
- **Single-threaded dispatch** — Node.js event loop eliminates race conditions
- **Orchestrator never writes to `tasks.db`** — the agent does that via its own tools
- **Agent writes via the `symphony` CLI** — the dispatched Claude Code agent has no special access to the database; it shells out to the same `symphony` command a human would use (`done`, `comment`, `state`, ...), resolving the right `tasks.db` via `$SYMPHONY_DB` injected into its environment
