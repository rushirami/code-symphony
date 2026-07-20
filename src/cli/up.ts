import { startService } from "../service.js";
import { createBoardServer, type BoardServer } from "../board/server.js";
import { ensureWebDist } from "../board/webdist.js";
import { createChildLogger } from "../logger.js";
import { str, type Flags } from "./context.js";

export async function runUp(workflowArg: string | undefined, flags: Flags): Promise<void> {
  const workflowPath = workflowArg ?? process.env.WORKFLOW_PATH ?? "./WORKFLOW.md";
  const actor = str(flags, "actor") ?? process.env.USER ?? "board";
  const portFlag = str(flags, "board-port");
  const port = portFlag !== undefined ? Number(portFlag) : 4400;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --board-port "${portFlag}"`);
  }

  // Resolve/build the web UI dist before starting the orchestrator: the
  // build's spawnSync (npm install/build) can block the event loop for
  // minutes, which would otherwise stall the live orchestrator's agent
  // pipes and SIGINT handling.
  const log = createChildLogger({ module: "board" });
  const webDist = ensureWebDist(log);

  const service = await startService(workflowPath);

  let board: BoardServer | undefined;
  try {
    board = createBoardServer({
      port,
      dbPath: service.config.tracker.dbPath,
      identifierPrefix: service.config.tracker.identifierPrefix,
      actor,
      webDist,
      log,
    });
    await board.start();
    console.log(`Board UI at http://localhost:${board.port} (db: ${service.config.tracker.dbPath})`);
  } catch (err) {
    log.error({ err }, "Board server failed to start; continuing with orchestrator only");
    board = undefined;
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Force-exit if stop() hangs; unref so this timer never keeps the process alive.
    setTimeout(() => process.exit(1), 5000).unref();
    (board ? board.stop() : Promise.resolve())
      .then(() => service.stop())
      .then(
        () => process.exit(0),
        (err) => {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        },
      );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
