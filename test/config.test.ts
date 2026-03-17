import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config/loader.js";

describe("loadConfig", () => {
  const validFrontmatter = {
    tracker: {
      kind: "linear",
      api_key: "lin_api_test123",
      project_slug: "my-project",
      active_states: ["Todo", "In Progress"],
    },
    polling: { interval_ms: 5000 },
    agent: { max_concurrent_agents: 3, max_turns: 10 },
    codex: { command: "claude" },
  };

  it("parses valid full config", () => {
    const config = loadConfig(validFrontmatter);
    expect(config.tracker.apiKey).toBe("lin_api_test123");
    expect(config.tracker.projectSlug).toBe("my-project");
    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(config.polling.intervalMs).toBe(5000);
    expect(config.agent.maxConcurrentAgents).toBe(3);
    expect(config.agent.maxTurns).toBe(10);
    expect(config.agent.command).toBe("claude");
  });

  it("applies defaults for omitted optional fields", () => {
    const config = loadConfig({
      tracker: { api_key: "key", project_slug: "proj" },
    });
    expect(config.tracker.kind).toBe("linear");
    expect(config.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(config.tracker.terminalStates).toEqual(["Done", "Cancelled"]);
    expect(config.polling.intervalMs).toBe(30_000);
    expect(config.agent.maxConcurrentAgents).toBe(10);
    expect(config.agent.maxTurns).toBe(20);
    expect(config.agent.maxRetryBackoffMs).toBe(300_000);
    expect(config.agent.turnTimeoutMs).toBe(3_600_000);
    expect(config.agent.stallTimeoutMs).toBe(300_000);
    expect(config.agent.command).toBe("claude");
    expect(config.workspace.root).toBe("/tmp/symphony_workspaces");
    expect(config.workspace.hooks.timeoutMs).toBe(60_000);
    expect(config.server.port).toBe(8080);
    expect(config.server.enabled).toBe(false);
  });

  describe("env var resolution", () => {
    const envKey = "SYMPHONY_TEST_API_KEY";

    beforeEach(() => {
      process.env[envKey] = "resolved-from-env";
    });

    afterEach(() => {
      delete process.env[envKey];
    });

    it("resolves $VAR syntax", () => {
      const config = loadConfig({
        tracker: { api_key: `$${envKey}`, project_slug: "proj" },
      });
      expect(config.tracker.apiKey).toBe("resolved-from-env");
    });

    it("resolves ${VAR} syntax", () => {
      const config = loadConfig({
        tracker: { api_key: `\${${envKey}}`, project_slug: "proj" },
      });
      expect(config.tracker.apiKey).toBe("resolved-from-env");
    });
  });

  it("rejects missing required fields", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ tracker: {} })).toThrow();
    expect(() =>
      loadConfig({ tracker: { api_key: "key" } }),
    ).toThrow();
  });

  it("rejects invalid types", () => {
    expect(() =>
      loadConfig({
        tracker: { api_key: "key", project_slug: "proj" },
        polling: { interval_ms: -1 },
      }),
    ).toThrow();

    expect(() =>
      loadConfig({
        tracker: { api_key: "key", project_slug: "proj" },
        agent: { max_concurrent_agents: 1.5 },
      }),
    ).toThrow();
  });

  it("merges frontmatter overrides over defaults", () => {
    const config = loadConfig({
      tracker: { api_key: "key", project_slug: "proj" },
      agent: { max_turns: 50 },
      workspace: { root: "/custom/path" },
    });
    expect(config.agent.maxTurns).toBe(50);
    expect(config.agent.maxConcurrentAgents).toBe(10); // default preserved
    expect(config.workspace.root).toBe("/custom/path");
  });
});
