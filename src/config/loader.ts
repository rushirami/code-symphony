import type { SymphonyConfig } from "../types.js";
import { WorkflowFrontmatterSchema, type ParsedWorkflowFrontmatter } from "./schema.js";

export function loadConfig(frontmatter: Record<string, unknown>): SymphonyConfig {
  const parsed = WorkflowFrontmatterSchema.parse(frontmatter);
  return toSymphonyConfig(parsed);
}

function toSymphonyConfig(p: ParsedWorkflowFrontmatter): SymphonyConfig {
  return {
    tracker: {
      kind: p.tracker.kind,
      endpoint: p.tracker.endpoint,
      apiKey: p.tracker.api_key,
      projectSlug: p.tracker.project_slug,
      activeStates: p.tracker.active_states,
      terminalStates: p.tracker.terminal_states,
    },
    polling: {
      intervalMs: p.polling.interval_ms,
    },
    agent: {
      command: p.codex.command,
      maxConcurrentAgents: p.agent.max_concurrent_agents,
      maxConcurrentAgentsByState: p.agent.max_concurrent_agents_by_state,
      maxTurns: p.agent.max_turns,
      maxRetries: p.agent.max_retries,
      maxRetryBackoffMs: p.agent.max_retry_backoff_ms,
      turnTimeoutMs: p.agent.turn_timeout_ms,
      stallTimeoutMs: p.agent.stall_timeout_ms,
      model: p.agent.model,
      allowedTools: p.agent.allowed_tools,
      appendSystemPrompt: p.agent.append_system_prompt,
      dangerouslySkipPermissions: p.agent.dangerously_skip_permissions,
    },
    workspace: {
      root: p.workspace.root,
      hooks: {
        afterCreate: p.workspace.hooks.after_create,
        beforeRun: p.workspace.hooks.before_run,
        afterRun: p.workspace.hooks.after_run,
        beforeRemove: p.workspace.hooks.before_remove,
        timeoutMs: p.workspace.hooks.timeout_ms,
      },
    },
    server: {
      port: p.server.port,
      enabled: p.server.enabled,
      dashboard: p.server.dashboard,
    },
  };
}
