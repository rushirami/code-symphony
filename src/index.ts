import chokidar from "chokidar";
import { parseWorkflow } from "./workflow/parser.js";
import { loadConfig } from "./config/loader.js";
import { createLinearClient } from "./tracker/linear.js";
import { createStateManager } from "./orchestrator/state.js";
import { createOrchestrator } from "./orchestrator/loop.js";
import { createWorkspaceManager } from "./workspace/manager.js";
import { createAgentRunner } from "./agent/runner.js";
import { createStatusServer, type StatusServer } from "./server/status.js";
import { createTerminalDashboard, type TerminalDashboard } from "./dashboard/terminal.js";
import { logger, createChildLogger } from "./logger.js";

const WORKFLOW_PATH = process.argv[2] ?? process.env.WORKFLOW_PATH ?? "./WORKFLOW.md";

async function main() {
  logger.info({ path: WORKFLOW_PATH }, "Symphony starting");

  // 1. Parse workflow
  let workflow = await parseWorkflow(WORKFLOW_PATH);
  logger.info("Workflow loaded");

  // 2. Load + validate config
  let config = loadConfig(workflow.config);
  logger.info(
    {
      project: config.tracker.projectSlug,
      maxConcurrent: config.agent.maxConcurrentAgents,
      pollInterval: config.polling.intervalMs,
    },
    "Config validated",
  );

  // 3. Terminal cleanup
  const tracker = createLinearClient(config.tracker, createChildLogger({ module: "tracker" }));
  try {
    const terminalIssues = await tracker.fetchIssuesByStates(config.tracker.terminalStates);
    const workspacesForCleanup = createWorkspaceManager(config.workspace, createChildLogger({ module: "cleanup" }));
    for (const issue of terminalIssues) {
      try {
        await workspacesForCleanup.remove(issue.identifier);
        logger.info({ issue: issue.identifier }, "Cleaned up terminal workspace");
      } catch {
        // Workspace may not exist, that's fine
      }
    }
  } catch (err) {
    logger.warn({ err }, "Terminal cleanup failed, continuing");
  }

  // 4. Wire up modules
  const state = createStateManager();
  const workspaces = createWorkspaceManager(config.workspace, createChildLogger({ module: "workspace" }));
  const agent = createAgentRunner(config.agent, createChildLogger({ module: "agent" }));
  const orchestrator = createOrchestrator(
    config,
    tracker,
    state,
    workspaces,
    agent,
    workflow.templateBody,
    createChildLogger({ module: "orchestrator" }),
  );

  // 5. Optional status server
  let statusServer: StatusServer | undefined;
  if (config.server.enabled) {
    statusServer = createStatusServer(
      config.server,
      state,
      orchestrator,
      createChildLogger({ module: "status" }),
    );
    try {
      await statusServer.start();
      logger.info({ port: statusServer.port }, "Status API listening");
    } catch (err) {
      logger.error({ err }, "Status server failed to start, continuing without it");
      statusServer = undefined;
    }
  }

  // 6. Optional terminal dashboard
  let dashboard: TerminalDashboard | undefined;
  if (config.server.dashboard) {
    dashboard = createTerminalDashboard(config, state, Date.now());
    dashboard.start();
  }

  // 7. Start orchestrator
  orchestrator.start();
  logger.info("Orchestrator running");

  // 8. Watch WORKFLOW.md for changes
  const watcher = chokidar.watch(WORKFLOW_PATH);
  watcher.on("change", async () => {
    logger.info("WORKFLOW.md changed, reloading");
    try {
      const newWorkflow = await parseWorkflow(WORKFLOW_PATH);
      const newConfig = loadConfig(newWorkflow.config);
      orchestrator.updateConfig(newConfig);
      orchestrator.updateTemplate(newWorkflow.templateBody);
      config = newConfig;
      workflow = newWorkflow;
      logger.info("Config and template reloaded");
    } catch (err) {
      logger.error({ err }, "Workflow reload failed, keeping last known good config");
    }
  });

  // 9. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    if (dashboard) dashboard.stop();
    await watcher.close();
    await orchestrator.stop();
    if (statusServer) await statusServer.stop();
    logger.info("Goodbye");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
