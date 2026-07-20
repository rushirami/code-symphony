import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config/loader.js";

describe("loadConfig", () => {
  const validFrontmatter = {
    tracker: {
      kind: "sqlite",
      db_path: "./my-tasks.db",
      identifier_prefix: "SYM",
      active_states: ["Todo", "In Progress"],
    },
    polling: { interval_ms: 5000 },
    agent: { max_concurrent_agents: 3, max_turns: 10 },
    runner: { command: "claude" },
  };

  it("parses valid full config", () => {
    const config = loadConfig(validFrontmatter);
    expect(config.tracker.kind).toBe("sqlite");
    expect(config.tracker.dbPath).toBe("./my-tasks.db");
    expect(config.tracker.identifierPrefix).toBe("SYM");
    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(config.polling.intervalMs).toBe(5000);
    expect(config.agent.maxConcurrentAgents).toBe(3);
    expect(config.agent.command).toBe("claude");
    expect(config.agent.env).toEqual({});
  });

  it("applies defaults: an empty config is now fully valid", () => {
    const config = loadConfig({});
    expect(config.tracker.kind).toBe("sqlite");
    expect(config.tracker.dbPath).toBe("./tasks.db");
    expect(config.tracker.identifierPrefix).toBe("TASK");
    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(config.tracker.terminalStates).toEqual(["Done", "Cancelled"]);
    expect(config.agent.command).toBe("claude");
  });

  describe("env var resolution on db_path", () => {
    const envKey = "SYMPHONY_TEST_DB_PATH";
    beforeEach(() => { process.env[envKey] = "/resolved/tasks.db"; });
    afterEach(() => { delete process.env[envKey]; });

    it("resolves $VAR syntax", () => {
      expect(loadConfig({ tracker: { db_path: `$${envKey}` } }).tracker.dbPath).toBe("/resolved/tasks.db");
    });
    it("resolves ${VAR} syntax", () => {
      expect(loadConfig({ tracker: { db_path: `\${${envKey}}` } }).tracker.dbPath).toBe("/resolved/tasks.db");
    });
  });

  it("rejects invalid types", () => {
    expect(() => loadConfig({ polling: { interval_ms: -1 } })).toThrow();
    expect(() => loadConfig({ agent: { max_concurrent_agents: 1.5 } })).toThrow();
    expect(() => loadConfig({ tracker: { kind: "linear" } })).toThrow();
  });

  it("merges frontmatter overrides over defaults", () => {
    const config = loadConfig({ agent: { max_turns: 50 }, workspace: { root: "/custom/path" } });
    expect(config.agent.maxTurns).toBe(50);
    expect(config.agent.maxConcurrentAgents).toBe(10);
    expect(config.workspace.root).toBe("/custom/path");
  });
});
