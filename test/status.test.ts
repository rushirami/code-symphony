import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createStatusServer } from "../src/server/status.js";
import { createStateManager } from "../src/orchestrator/state.js";
import { makeIssue } from "./helpers.js";
import pino from "pino";
import type { Orchestrator } from "../src/types.js";

const log = pino({ level: "silent" });

describe("StatusServer", () => {
  let serverUrl: string;
  let statusServer: Awaited<ReturnType<typeof createStatusServer>>;
  let state: ReturnType<typeof createStateManager>;
  let refreshCalled = false;

  const fakeOrchestrator: Orchestrator = {
    start: () => {},
    stop: async () => {},
    refresh: async () => { refreshCalled = true; },
    updateConfig: () => {},
    updateTemplate: () => {},
  };

  beforeAll(async () => {
    state = createStateManager();
    statusServer = createStatusServer(
      { port: 0, enabled: true, dashboard: false },
      state,
      fakeOrchestrator,
      log,
    );
    await statusServer.start();
    serverUrl = `http://localhost:${statusServer.port}`;
  });

  afterAll(async () => {
    await statusServer.stop();
  });

  it("GET /api/v1/state returns orchestrator snapshot", async () => {
    state.claim(makeIssue({ identifier: "PROJ-1" }));
    state.claim(makeIssue({ identifier: "PROJ-2", id: "uuid-2" }));
    state.markRunning("PROJ-1", "session-1");

    const res = await fetch(`${serverUrl}/api/v1/state`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.runningCount).toBe(1);
    expect(body.claimedCount).toBe(1);
    expect(body.workers).toHaveLength(2);

    // Cleanup
    state.release("PROJ-1");
    state.release("PROJ-2");
  });

  it("GET /api/v1/:identifier returns worker details", async () => {
    state.claim(makeIssue({ identifier: "PROJ-10" }));

    const res = await fetch(`${serverUrl}/api/v1/PROJ-10`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.identifier).toBe("PROJ-10");
    expect(body.phase).toBe("claimed");

    state.release("PROJ-10");
  });

  it("GET /api/v1/:identifier returns 404 for unknown", async () => {
    const res = await fetch(`${serverUrl}/api/v1/NONEXISTENT`);
    expect(res.status).toBe(404);
  });

  it("POST /api/v1/refresh returns 202 and triggers refresh", async () => {
    refreshCalled = false;

    const res = await fetch(`${serverUrl}/api/v1/refresh`, { method: "POST" });
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.status).toBe("refresh queued");

    // Wait a tick for async refresh to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(refreshCalled).toBe(true);
  });

  it("unknown route returns 404", async () => {
    const res = await fetch(`${serverUrl}/unknown`);
    expect(res.status).toBe(404);
  });
});
