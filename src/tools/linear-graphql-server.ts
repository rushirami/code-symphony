/**
 * Minimal MCP stdio server that exposes a `linear_graphql` tool.
 * Executed as a subprocess by the agent runner when enableLinearTool is true.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (one JSON object per line).
 *
 * Usage: node linear-graphql-server.js <endpoint> <api_key>
 */
import { createInterface } from "node:readline";

const endpoint = process.env.SYMPHONY_LINEAR_ENDPOINT ?? process.argv[2];
const apiKey = process.env.SYMPHONY_LINEAR_API_KEY ?? process.argv[3];

if (!endpoint || !apiKey) {
  process.stderr.write(
    "Set SYMPHONY_LINEAR_ENDPOINT and SYMPHONY_LINEAR_API_KEY env vars, " +
    "or pass as: linear-graphql-server <endpoint> <api_key>\n",
  );
  process.exit(1);
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface ToolCallParams {
  name: string;
  arguments: {
    query: string;
    variables?: Record<string, unknown>;
  };
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResult(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: number | string, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function executeGraphQL(
  query: string,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  // Reject multiple operations
  const opCount = (query.match(/(?:query|mutation|subscription)\s/g) ?? []).length;
  if (opCount > 1) {
    throw new Error("Multiple operations in a single query are not allowed");
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linear API ${res.status}: ${body}`);
  }

  return res.json();
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  if (req.method === "initialize") {
    sendResult(req.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "symphony-linear-graphql", version: "0.1.0" },
    });
    return;
  }

  if (req.method === "notifications/initialized") {
    return; // no response needed
  }

  if (req.method === "tools/list") {
    sendResult(req.id, {
      tools: [
        {
          name: "linear_graphql",
          description:
            "Execute a GraphQL query or mutation against the Linear API. " +
            "Uses Symphony's configured credentials. " +
            "Only one operation per request.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "GraphQL query or mutation string",
              },
              variables: {
                type: "object",
                description: "GraphQL variables (optional)",
              },
            },
            required: ["query"],
          },
        },
      ],
    });
    return;
  }

  if (req.method === "tools/call") {
    const params = req.params as ToolCallParams;
    if (params.name !== "linear_graphql") {
      sendError(req.id, -32602, `Unknown tool: ${params.name}`);
      return;
    }

    try {
      const result = await executeGraphQL(
        params.arguments.query,
        params.arguments.variables,
      );
      sendResult(req.id, {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      });
    } catch (err) {
      sendResult(req.id, {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      });
    }
    return;
  }

  sendError(req.id, -32601, `Unknown method: ${req.method}`);
}

// Main loop: read JSON-RPC from stdin
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  try {
    const req = JSON.parse(line) as JsonRpcRequest;
    handleRequest(req).catch((err) => {
      if (req.id !== undefined) {
        sendError(req.id, -32603, String(err));
      }
    });
  } catch {
    // Invalid JSON, ignore
  }
});
