import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface FakeLinearServer {
  start(): Promise<number>;
  stop(): Promise<void>;
  port: number;
  setResponse(operationName: string, response: unknown): void;
  setError(statusCode: number, body: string): void;
  getRequests(): Array<{ query: string; variables: Record<string, unknown> }>;
  clearRequests(): void;
}

export function createFakeLinearServer(): FakeLinearServer {
  let server: Server;
  let port = 0;
  const responses = new Map<string, unknown>();
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let errorOverride: { statusCode: number; body: string } | null = null;

  function handler(req: IncomingMessage, res: ServerResponse) {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      if (errorOverride) {
        res.writeHead(errorOverride.statusCode, { "Content-Type": "text/plain" });
        res.end(errorOverride.body);
        return;
      }

      try {
        const parsed = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
        requests.push(parsed);

        // Match operation name from query
        const opMatch = parsed.query.match(/(?:query|mutation)\s+(\w+)/);
        const opName = opMatch?.[1] ?? "";

        const responseData = responses.get(opName);
        if (responseData) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: responseData }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ errors: [{ message: `No mock for operation: ${opName}` }] }));
        }
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid JSON");
      }
    });
  }

  return {
    get port() { return port; },

    async start() {
      server = createServer(handler);
      return new Promise<number>((resolve) => {
        server.listen(0, () => {
          const addr = server.address();
          port = typeof addr === "object" && addr ? addr.port : 0;
          resolve(port);
        });
      });
    },

    async stop() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },

    setResponse(operationName: string, response: unknown) {
      errorOverride = null;
      responses.set(operationName, response);
    },

    setError(statusCode: number, body: string) {
      errorOverride = { statusCode, body };
    },

    getRequests() { return requests; },

    clearRequests() { requests.length = 0; },
  };
}
