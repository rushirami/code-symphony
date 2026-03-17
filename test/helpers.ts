import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import type { TrackerIssue, SymphonyConfig } from "../src/types.js";

const tmpDirs: string[] = [];

export async function useTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "symphony-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

export function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: "issue-uuid-1",
    identifier: "PROJ-1",
    title: "Fix the login bug",
    description: "Users cannot log in when using SSO.",
    state: "Todo",
    priority: 1,
    url: "https://linear.app/team/issue/PROJ-1",
    labels: ["bug", "auth"],
    branchName: "proj-1-fix-login",
    blockedBy: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<SymphonyConfig> = {}): SymphonyConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "test-api-key",
      projectSlug: "test-project",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Cancelled"],
      ...overrides.tracker,
    },
    polling: {
      intervalMs: 1000,
      ...overrides.polling,
    },
    agent: {
      command: "claude",
      maxConcurrentAgents: 2,
      maxConcurrentAgentsByState: {},
      maxTurns: 5,
      maxRetries: 3,
      maxRetryBackoffMs: 10000,
      turnTimeoutMs: 60000,
      stallTimeoutMs: 5000,
      allowedTools: ["Bash", "Read", "Edit", "Write"],
      dangerouslySkipPermissions: false,
      ...overrides.agent,
    },
    workspace: {
      root: "/tmp/symphony-test-workspaces",
      hooks: {
        timeoutMs: 5000,
        ...overrides.workspace?.hooks,
      },
      ...overrides.workspace,
      // Re-apply hooks since spread above may have been overwritten
    },
    server: {
      port: 0,
      enabled: false,
      dashboard: false,
      ...overrides.server,
    },
  };
}

export async function writeWorkflow(
  dir: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<string> {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const content = `---\n${yaml}\n---\n${body}`;
  const filePath = path.join(dir, "WORKFLOW.md");
  await writeFile(filePath, content, "utf-8");
  return filePath;
}
