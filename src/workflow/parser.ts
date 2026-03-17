import matter from "gray-matter";
import { Liquid } from "liquidjs";
import { readFile } from "node:fs/promises";
import type { WorkflowDefinition } from "../types.js";

const liquid = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

export async function parseWorkflow(filePath: string): Promise<WorkflowDefinition> {
  const raw = await readFile(filePath, "utf-8");
  const { data, content } = matter(raw);
  return {
    config: data as Record<string, unknown>,
    templateBody: content.trim(),
  };
}

export async function renderPrompt(
  template: string,
  variables: Record<string, unknown>,
): Promise<string> {
  return liquid.parseAndRender(template, variables);
}
