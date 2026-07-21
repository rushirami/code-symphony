import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import matter from "gray-matter";

export type Flags = Record<string, string | boolean>;

export function str(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function findWorkflow(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, "WORKFLOW.md");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveDbContext(flags: Flags): { dbPath: string; prefix: string } {
  let workflowDb: string | null = null;
  let prefix = "TASK";
  const workflowPath = findWorkflow(process.cwd());
  if (workflowPath) {
    try {
      const fm = matter(readFileSync(workflowPath, "utf-8")).data as {
        tracker?: { db_path?: string; identifier_prefix?: string };
      };
      if (fm.tracker?.db_path) workflowDb = path.resolve(path.dirname(workflowPath), fm.tracker.db_path);
      if (fm.tracker?.identifier_prefix) prefix = fm.tracker.identifier_prefix;
    } catch {
      // Unparseable WORKFLOW.md: fall back to defaults
    }
  }
  const flagDb = str(flags, "db");
  const envDb = process.env.SYMPHONY_DB;
  const dbPath = flagDb ? path.resolve(flagDb)
    : envDb ? path.resolve(envDb)
    : workflowDb ?? path.resolve("tasks.db");
  return { dbPath, prefix };
}
