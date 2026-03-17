import { describe, it, expect } from "vitest";
import { parseWorkflow, renderPrompt } from "../src/workflow/parser.js";
import { useTmpDir, writeWorkflow, makeIssue } from "./helpers.js";

describe("parseWorkflow", () => {
  it("parses YAML frontmatter and markdown body", async () => {
    const dir = await useTmpDir();
    const filePath = await writeWorkflow(
      dir,
      { tracker: { api_key: "key123", project_slug: "proj" } },
      "Hello {{ issue.title }}",
    );

    const wf = await parseWorkflow(filePath);
    expect(wf.config.tracker).toEqual({ api_key: "key123", project_slug: "proj" });
    expect(wf.templateBody).toBe("Hello {{ issue.title }}");
  });

  it("handles complex YAML frontmatter", async () => {
    const dir = await useTmpDir();
    const content = `---
tracker:
  kind: linear
  api_key: test
  project_slug: proj
  active_states:
    - Todo
    - In Progress
agent:
  max_turns: 30
---
Body here`;
    const filePath = dir + "/WORKFLOW.md";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, content, "utf-8");

    const wf = await parseWorkflow(filePath);
    const tracker = wf.config.tracker as Record<string, unknown>;
    expect(tracker.active_states).toEqual(["Todo", "In Progress"]);
    const agent = wf.config.agent as Record<string, unknown>;
    expect(agent.max_turns).toBe(30);
    expect(wf.templateBody).toBe("Body here");
  });
});

describe("renderPrompt", () => {
  it("interpolates issue fields", async () => {
    const template = "Working on {{ issue.identifier }}: {{ issue.title }}";
    const issue = makeIssue();
    const result = await renderPrompt(template, { issue });
    expect(result).toBe("Working on PROJ-1: Fix the login bug");
  });

  it("throws on undefined variable (strictVariables)", async () => {
    const template = "Hello {{ nonexistent }}";
    await expect(renderPrompt(template, {})).rejects.toThrow();
  });

  it("throws on undefined filter (strictFilters)", async () => {
    const template = "{{ issue.title | bogusFilter }}";
    const issue = makeIssue();
    await expect(renderPrompt(template, { issue })).rejects.toThrow();
  });

  it("handles for loops over labels", async () => {
    const template =
      "Labels:{% for label in issue.labels %} {{ label }}{% endfor %}";
    const issue = makeIssue({ labels: ["bug", "auth"] });
    const result = await renderPrompt(template, { issue });
    expect(result).toBe("Labels: bug auth");
  });

  it("handles conditional with null attempt", async () => {
    const template =
      "{% if attempt %}Retry #{{ attempt }}{% endif %}Done";
    const result = await renderPrompt(template, { attempt: null });
    expect(result).toBe("Done");
  });

  it("handles conditional with integer attempt", async () => {
    const template =
      "{% if attempt %}Retry #{{ attempt }} {% endif %}Done";
    const result = await renderPrompt(template, { attempt: 2 });
    expect(result).toBe("Retry #2 Done");
  });

  it("renders issue description", async () => {
    const template = "Desc: {{ issue.description }}";
    const issue = makeIssue({ description: "Fix SSO login" });
    const result = await renderPrompt(template, { issue });
    expect(result).toBe("Desc: Fix SSO login");
  });
});
