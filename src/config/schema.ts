import { z } from "zod";

function envString() {
  return z.preprocess((val) => {
    if (typeof val === "string" && val.startsWith("$")) {
      const varName = val.startsWith("${")
        ? val.slice(2, -1)
        : val.slice(1);
      const resolved = process.env[varName];
      if (resolved === undefined) {
        return val; // let Zod validation handle missing env vars
      }
      return resolved;
    }
    return val;
  }, z.string());
}

export const HooksConfigSchema = z.object({
  after_create: z.string().optional(),
  before_run: z.string().optional(),
  after_run: z.string().optional(),
  before_remove: z.string().optional(),
  timeout_ms: z.number().int().positive().default(60_000),
});

export const TrackerConfigSchema = z.object({
  kind: z.literal("linear").default("linear"),
  endpoint: z.string().default("https://api.linear.app/graphql"),
  api_key: envString(),
  project_slug: z.string(),
  active_states: z.array(z.string()).default(["Todo", "In Progress"]),
  terminal_states: z.array(z.string()).default(["Done", "Cancelled"]),
});

export const PollingConfigSchema = z.object({
  interval_ms: z.number().int().positive().default(30_000),
});

export const AgentConfigSchema = z.object({
  max_concurrent_agents: z.number().int().positive().default(10),
  max_concurrent_agents_by_state: z.record(z.string(), z.number().int().positive()).default({}),
  max_turns: z.number().int().positive().default(20),
  max_retries: z.number().int().nonnegative().default(3),
  max_retry_backoff_ms: z.number().int().positive().default(300_000),
  turn_timeout_ms: z.number().int().positive().default(3_600_000),
  stall_timeout_ms: z.number().int().default(300_000),
  model: z.string().optional(),
  allowed_tools: z.array(z.string()).default(["Bash", "Read", "Edit", "Write", "Grep", "Glob"]),
  append_system_prompt: z.string().optional(),
  dangerously_skip_permissions: z.boolean().default(false),
});

export const WorkspaceConfigSchema = z.object({
  root: z.string().default("/tmp/symphony_workspaces"),
  hooks: HooksConfigSchema.default({}),
});

export const CodexConfigSchema = z.object({
  command: z.string().default("claude"),
});

export const ServerConfigSchema = z.object({
  port: z.number().int().nonnegative().default(8080),
  enabled: z.boolean().default(false),
  dashboard: z.boolean().default(false),
});

export const WorkflowFrontmatterSchema = z.object({
  tracker: TrackerConfigSchema,
  polling: PollingConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
  workspace: WorkspaceConfigSchema.default({}),
  codex: CodexConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
});

export type RawWorkflowFrontmatter = z.input<typeof WorkflowFrontmatterSchema>;
export type ParsedWorkflowFrontmatter = z.output<typeof WorkflowFrontmatterSchema>;
