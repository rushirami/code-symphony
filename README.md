# Claude Symphony

A long-running automation service that polls [Linear](https://linear.app) for issues, dispatches them to isolated workspaces, and runs [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a coding agent per issue. Based on the [OpenAI Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md), adapted to use Claude Code instead of Codex.

Symphony is a **scheduler/runner** — it reads from the tracker but never writes to it. The coding agent (Claude Code) uses its own tools to update issue state.

## Architecture

```
┌─────────────┐     poll      ┌─────────────┐
│   Linear    │◄──────────────│ Orchestrator │
│  (tracker)  │  GraphQL API  │   (loop.ts)  │
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
             ├── proj-1/   ┌──────────┐
             └── proj-2/   │ Claude   │
                           │ Code CLI │
                           └──────────┘
```

## How it works

1. **Poll** — Fetches issues from Linear in configured active states (e.g. "Todo", "In Progress")
2. **Dispatch** — Claims eligible issues, creates isolated workspace directories, renders a Liquid prompt template
3. **Run** — Spawns `claude -p` as a child process per issue with `--output-format stream-json`, parses NDJSON events
4. **Continue** — After each turn, checks if the issue is still active and `turnsCompleted < maxTurns`. If so, re-dispatches with `--resume <sessionId>` after a 1s delay using a short continuation prompt (the full prompt was only sent on turn 1)
5. **Reconcile** — Each tick checks running agents for stalls, refreshes issue states from Linear, stops agents for terminal issues
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
| **Linear Client** | `src/tracker/linear.ts` | GraphQL client with cursor pagination (native fetch, no SDK) |
| **State Machine** | `src/orchestrator/state.ts` | In-memory worker states: claimed → running → retry_queued → released |
| **Orchestrator** | `src/orchestrator/loop.ts` | Poll-dispatch loop, concurrency control, reconciliation, retry backoff |
| **Workspace Manager** | `src/workspace/manager.ts` | Per-issue directories, path sanitization, lifecycle hooks |
| **Agent Runner** | `src/agent/runner.ts` | Spawns Claude CLI, parses NDJSON stream, session management, per-issue log files |
| **Status Server** | `src/server/status.ts` | Optional HTTP API (`GET /api/v1/state`, `GET /api/v1/:id`, `POST /api/v1/refresh`) |
| **Dashboard** | `src/dashboard/terminal.ts` | Optional ANSI terminal dashboard with live worker status, turn counts, and costs |
| **Linear Tool** | `src/tools/linear-graphql-server.ts` | MCP server exposing Linear GraphQL to agent sessions |
| **Entry Point** | `src/index.ts` | Composition root, chokidar file watcher for hot-reload, graceful shutdown |

## Setup

```bash
npm install
```

Requires Node.js >= 20 and `claude` CLI installed.

## Configuration

All configuration lives in a `WORKFLOW.md` file — YAML frontmatter for settings, Markdown body for the prompt template:

```markdown
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-project
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
codex:
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
```

Environment variables are resolved via `$VAR` or `${VAR}` syntax. The prompt template uses [Liquid](https://liquidjs.com/) with strict mode — undefined variables/filters cause errors.

## Usage

```bash
# Run with default WORKFLOW.md in current directory
npm start

# Run with a specific workflow file
npx tsx src/index.ts /path/to/WORKFLOW.md

# Set log level
LOG_LEVEL=debug npm start
```

The service runs continuously, polling Linear every `interval_ms`. Modify `WORKFLOW.md` while running — changes are hot-reloaded without restart. Send `SIGINT` or `SIGTERM` for graceful shutdown.

## Status API

When `server.enabled: true`, the HTTP API provides:

- `GET /api/v1/state` — Full orchestrator snapshot (all workers, turn counts, cumulative cost)
- `GET /api/v1/PROJ-123` — Single worker details (turns completed, session ID, cost)
- `POST /api/v1/refresh` — Trigger immediate poll cycle

## Terminal Dashboard

When `server.dashboard: true`, Symphony renders a live ANSI terminal display refreshing every second:

```
♫ Symphony  my-project
Uptime: 5m 23s  |  Poll: 30s  |  Max agents: 10

  ● 2 running  ○ 0 claimed  ◌ 1 retrying  | 14 turns | $0.4200

  ISSUE          STATE          PHASE          TURNS    COST       ELAPSED
  ──────────────────────────────────────────────────────────────────────────
  PROJ-1         In Progress    running        5        $0.2100    3m 12s
  PROJ-2         Todo           running        3        $0.1500    1m 45s
  PROJ-3         In Progress    retry_queued   2        $0.0600    -
    └ retry in 8s
```

## Tests

```bash
npm test              # run all tests
npx vitest            # watch mode
npx tsx test/smoke.ts # end-to-end smoke test with fake Linear + fake Claude
```

**87 tests** across 9 files, all end-to-end with no mocks:

- **Fake Claude scripts** (`test/fixtures/fake-claude*.sh`) — Real shell scripts emitting NDJSON, testing the actual spawn + parse pipeline
- **Fake Linear server** (`test/fixtures/fake-linear-server.ts`) — Real HTTP server with configurable GraphQL responses
- **Real filesystem** for workspace tests (temp directories)
- **Full integration** tests wiring all components together

## Per-issue log files

Each agent turn writes its full NDJSON stream to the workspace at `.symphony/turn-N.ndjson`. This lets you replay exactly what the agent did:

```
workspaces/proj-1/.symphony/
├── turn-0.ndjson   # First turn (full prompt)
├── turn-1.ndjson   # Continuation turn
└── turn-2.ndjson   # Another continuation
```

## Key design decisions

- **Multi-turn continuation loop** — After each turn, checks issue state on Linear and re-dispatches with `--resume` if still active (up to `max_turns`)
- **Turn 1 gets full prompt, turns 2+ get minimal** — "Continue working on PROJ-1. Pick up where you left off." Since `--resume` preserves conversation history, the full prompt would be redundant
- **Claude Code CLI** instead of Codex JSON-RPC — uses `claude -p --output-format stream-json --verbose` for structured output
- **Token/cost tracking** — Accumulates `total_cost_usd` and `duration_ms` across all turns per worker, exposed in snapshot API and dashboard
- **No database** — in-memory state, Linear as source of truth on restart
- **Single-threaded dispatch** — Node.js event loop eliminates race conditions
- **Orchestrator never writes to Linear** — the agent does that via its own tools
- **`linear_graphql` MCP tool** — Optional MCP server that gives the agent access to Linear's GraphQL API using Symphony's credentials
