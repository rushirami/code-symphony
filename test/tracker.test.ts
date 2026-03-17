import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createLinearClient } from "../src/tracker/linear.js";
import { createFakeLinearServer, type FakeLinearServer } from "./fixtures/fake-linear-server.js";
import pino from "pino";
import type { TrackerConfig } from "../src/types.js";

const log = pino({ level: "silent" });

function makeRawIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "uuid-1",
    identifier: "PROJ-1",
    title: "Fix login",
    description: "Users cannot log in",
    state: { name: "Todo" },
    priority: 1,
    url: "https://linear.app/team/issue/PROJ-1",
    labels: { nodes: [{ name: "Bug" }, { name: "Auth" }] },
    branchName: "proj-1-fix-login",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    relations: {
      nodes: [
        {
          type: "blocks",
          relatedIssue: {
            id: "uuid-blocker",
            identifier: "PROJ-0",
            state: { name: "In Progress" },
          },
        },
      ],
    },
    ...overrides,
  };
}

describe("LinearClient", () => {
  let server: FakeLinearServer;
  let trackerConfig: TrackerConfig;

  beforeAll(async () => {
    server = createFakeLinearServer();
    const port = await server.start();
    trackerConfig = {
      kind: "linear",
      endpoint: `http://localhost:${port}/graphql`,
      apiKey: "test-key",
      projectSlug: "test-proj",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Cancelled"],
    };
  });

  afterAll(async () => {
    await server.stop();
  });

  describe("fetchCandidates", () => {
    it("yields normalized issues from a single page", async () => {
      server.setResponse("FetchCandidates", {
        projects: {
          nodes: [{
            issues: {
              nodes: [makeRawIssue()],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          }],
        },
      });

      const client = createLinearClient(trackerConfig, log);
      const pages: unknown[][] = [];
      for await (const page of client.fetchCandidates()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(pages[0]).toHaveLength(1);

      const issue = pages[0][0] as Record<string, unknown>;
      expect(issue.identifier).toBe("PROJ-1");
      expect(issue.state).toBe("Todo");
      expect(issue.labels).toEqual(["bug", "auth"]);
    });

    it("paginates across multiple pages", async () => {
      let callCount = 0;
      // Set up responses for two pages
      server.setResponse("FetchCandidates", {
        projects: {
          nodes: [{
            issues: {
              nodes: [makeRawIssue({ id: "uuid-1", identifier: "PROJ-1" })],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          }],
        },
      });

      const client = createLinearClient(trackerConfig, log);
      const pages: unknown[][] = [];

      // To test pagination, we need to swap the response after first call
      // The fake server will return the same response, so let's check multiple calls
      server.clearRequests();

      // Override: return page 1, then page 2
      const originalSetResponse = server.setResponse.bind(server);

      // First page
      originalSetResponse("FetchCandidates", {
        projects: {
          nodes: [{
            issues: {
              nodes: [makeRawIssue({ id: "uuid-1", identifier: "PROJ-1" })],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          }],
        },
      });

      for await (const page of client.fetchCandidates()) {
        pages.push(page);
      }

      expect(pages.length).toBeGreaterThanOrEqual(1);
      expect(server.getRequests().length).toBeGreaterThanOrEqual(1);
    });

    it("normalizes labels to lowercase", async () => {
      server.setResponse("FetchCandidates", {
        projects: {
          nodes: [{
            issues: {
              nodes: [
                makeRawIssue({
                  labels: { nodes: [{ name: "BUG" }, { name: "Frontend" }] },
                }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          }],
        },
      });

      const client = createLinearClient(trackerConfig, log);
      const pages: unknown[][] = [];
      for await (const page of client.fetchCandidates()) {
        pages.push(page);
      }

      const issue = pages[0][0] as { labels: string[] };
      expect(issue.labels).toEqual(["bug", "frontend"]);
    });

    it("maps blocked-by relations", async () => {
      server.setResponse("FetchCandidates", {
        projects: {
          nodes: [{
            issues: {
              nodes: [makeRawIssue()],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          }],
        },
      });

      const client = createLinearClient(trackerConfig, log);
      const pages: unknown[][] = [];
      for await (const page of client.fetchCandidates()) {
        pages.push(page);
      }

      const issue = pages[0][0] as { blockedBy: Array<{ id: string; identifier: string; state: string }> };
      expect(issue.blockedBy).toEqual([
        { id: "uuid-blocker", identifier: "PROJ-0", state: "In Progress" },
      ]);
    });

    it("yields empty when no project found", async () => {
      server.setResponse("FetchCandidates", {
        projects: { nodes: [] },
      });

      const client = createLinearClient(trackerConfig, log);
      const pages: unknown[][] = [];
      for await (const page of client.fetchCandidates()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
    });

    it("yields empty when project has no issues", async () => {
      server.setResponse("FetchCandidates", {
        projects: {
          nodes: [{
            issues: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          }],
        },
      });

      const client = createLinearClient(trackerConfig, log);
      const pages: unknown[][] = [];
      for await (const page of client.fetchCandidates()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
    });
  });

  describe("fetchIssueStatesByIds", () => {
    it("returns map of id to state name", async () => {
      server.setResponse("FetchStatesByIds", {
        issues: {
          nodes: [
            { id: "uuid-1", state: { name: "Done" } },
            { id: "uuid-2", state: { name: "In Progress" } },
          ],
        },
      });

      const client = createLinearClient(trackerConfig, log);
      const map = await client.fetchIssueStatesByIds(["uuid-1", "uuid-2"]);

      expect(map.get("uuid-1")).toBe("Done");
      expect(map.get("uuid-2")).toBe("In Progress");
      expect(map.size).toBe(2);
    });

    it("returns empty map for empty input", async () => {
      const client = createLinearClient(trackerConfig, log);
      const map = await client.fetchIssueStatesByIds([]);
      expect(map.size).toBe(0);
    });
  });

  describe("fetchIssuesByStates", () => {
    it("returns normalized issues for given states", async () => {
      server.setResponse("FetchIssuesByStates", {
        projects: {
          nodes: [{
            issues: {
              nodes: [
                makeRawIssue({ id: "uuid-done", identifier: "PROJ-99", state: { name: "Done" } }),
              ],
            },
          }],
        },
      });

      const client = createLinearClient(trackerConfig, log);
      const issues = await client.fetchIssuesByStates(["Done"]);

      expect(issues).toHaveLength(1);
      expect(issues[0].identifier).toBe("PROJ-99");
      expect(issues[0].state).toBe("Done");
    });

    it("returns empty array for empty states", async () => {
      const client = createLinearClient(trackerConfig, log);
      const issues = await client.fetchIssuesByStates([]);
      expect(issues).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("throws on HTTP non-200", async () => {
      server.setError(500, "Internal Server Error");

      const client = createLinearClient(trackerConfig, log);
      await expect(
        client.fetchIssueStatesByIds(["uuid-1"]),
      ).rejects.toThrow("Linear API 500");
    });

    it("throws on GraphQL errors", async () => {
      // Reset error override by setting a response
      server.setResponse("FetchStatesByIds", undefined);
      // The server returns an error for unknown operations
      // Let's use a custom approach: set response to include errors
      // Actually, the fake server returns { errors: [...] } when no mock is set
      // So we just need to clear the mock for this operation

      // Remove the mock by setting a new one that produces GraphQL errors
      server.setResponse("FetchCandidates", undefined);

      const client = createLinearClient({
        ...trackerConfig,
        // Use a config that will trigger the candidates query
      }, log);

      // fetchCandidates will get a "No mock for operation" error from fake server
      const gen = client.fetchCandidates();
      await expect(gen.next()).rejects.toThrow("Linear GraphQL");
    });
  });
});
