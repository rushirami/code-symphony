import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { ServerConfig, StateManager, Orchestrator } from "../types.js";
import type { Logger } from "pino";

export interface StatusServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createStatusServer(
  config: ServerConfig,
  state: StateManager,
  orchestrator: Orchestrator,
  log: Logger,
): StatusServer {
  let server: Server;
  let actualPort = 0;

  function handler(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://localhost:${actualPort}`);

    if (req.method === "GET" && url.pathname === "/api/v1/state") {
      const snapshot = state.toSnapshot();
      json(res, 200, snapshot);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/v1/")) {
      const identifier = decodeURIComponent(url.pathname.slice("/api/v1/".length));
      if (identifier) {
        const worker = state.getWorker(identifier);
        if (worker) {
          json(res, 200, { identifier, ...worker });
        } else {
          json(res, 404, { error: "Not found" });
        }
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/v1/refresh") {
      orchestrator.refresh().catch((err) => {
        log.error({ err }, "Refresh triggered via API failed");
      });
      json(res, 202, { status: "refresh queued" });
      return;
    }

    json(res, 404, { error: "Not found" });
  }

  return {
    get port() { return actualPort; },

    async start() {
      server = createServer(handler);
      return new Promise<void>((resolve, reject) => {
        server.on("error", reject);
        server.listen(config.port, () => {
          const addr = server.address();
          actualPort = typeof addr === "object" && addr ? addr.port : config.port;
          log.info({ port: actualPort }, "Status server listening");
          resolve();
        });
      });
    },

    async stop() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
