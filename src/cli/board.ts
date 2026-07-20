import { createChildLogger } from "../logger.js";
import { createBoardServer } from "../board/server.js";
import { ensureWebDist } from "../board/webdist.js";
import { resolveDbContext, str, type Flags } from "./context.js";

export async function runBoard(flags: Flags): Promise<void> {
  const log = createChildLogger({ module: "board" });
  const { dbPath, prefix } = resolveDbContext(flags);
  const actor = str(flags, "actor") ?? process.env.USER ?? "board";
  const portFlag = str(flags, "port");
  const port = portFlag !== undefined ? Number(portFlag) : 4400;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port "${portFlag}"`);
  }
  const webDist = ensureWebDist(log);
  const server = createBoardServer({ port, dbPath, actor, identifierPrefix: prefix, webDist, log });
  await server.start();
  console.log(`Board UI at http://localhost:${server.port} (db: ${dbPath})`);
  const shutdown = async (): Promise<void> => {
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
