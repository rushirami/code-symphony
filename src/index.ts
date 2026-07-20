import { startService } from "./service.js";
import { logger } from "./logger.js";

const WORKFLOW_PATH = process.argv[2] ?? process.env.WORKFLOW_PATH ?? "./WORKFLOW.md";

startService(WORKFLOW_PATH)
  .then((service) => {
    const shutdown = async (signal: string): Promise<void> => {
      logger.info({ signal }, "Shutting down");
      await service.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  })
  .catch((err) => {
    logger.fatal({ err }, "Fatal startup error");
    process.exit(1);
  });
