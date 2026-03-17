import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import type { WorkspaceConfig, WorkspaceManager, TrackerIssue } from "../types.js";
import type { Logger } from "pino";

function sanitize(identifier: string): string {
  return identifier.toLowerCase().replace(/[^a-z0-9._-]/g, "_");
}

export function createWorkspaceManager(
  config: WorkspaceConfig,
  log: Logger,
): WorkspaceManager {
  const resolvedRoot = path.resolve(config.root);
  const createdSet = new Set<string>();

  function getPath(identifier: string): string {
    const dirName = sanitize(identifier);
    const wsPath = path.resolve(resolvedRoot, dirName);

    // Path containment check
    if (!wsPath.startsWith(resolvedRoot + path.sep) && wsPath !== resolvedRoot) {
      throw new Error(
        `Workspace path escapes root: ${wsPath} is not under ${resolvedRoot}`,
      );
    }

    return wsPath;
  }

  async function runHookInternal(
    hookName: string,
    script: string | undefined,
    cwd: string,
    abort: boolean,
  ): Promise<void> {
    if (!script) return;

    log.info({ hookName, cwd }, "Running hook");

    return new Promise<void>((resolve, reject) => {
      const child = exec(
        script,
        { cwd, timeout: config.hooks.timeoutMs, shell: "/bin/sh" },
        (err, stdout, stderr) => {
          if (err) {
            log.error({ hookName, stderr: stderr.trim() }, "Hook failed");
            if (abort) {
              reject(new Error(`Hook ${hookName} failed: ${err.message}`));
            } else {
              resolve();
            }
          } else {
            log.debug({ hookName, stdout: stdout.trim() }, "Hook completed");
            resolve();
          }
        },
      );
    });
  }

  async function ensure(issue: TrackerIssue): Promise<string> {
    const wsPath = getPath(issue.identifier);

    const exists = await stat(wsPath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      await mkdir(wsPath, { recursive: true });
      createdSet.add(issue.identifier);

      // Run after_create hook (abort on failure)
      await runHookInternal("afterCreate", config.hooks.afterCreate, wsPath, true);
    }

    return wsPath;
  }

  async function remove(identifier: string): Promise<void> {
    const wsPath = getPath(identifier);

    // Run before_remove hook (don't abort on failure)
    await runHookInternal("beforeRemove", config.hooks.beforeRemove, wsPath, false);

    await rm(wsPath, { recursive: true, force: true });
    createdSet.delete(identifier);
  }

  async function runHook(
    hookName: "beforeRun" | "afterRun",
    cwd: string,
  ): Promise<void> {
    const script = config.hooks[hookName];
    const abort = hookName === "beforeRun";
    await runHookInternal(hookName, script, cwd, abort);
  }

  return { ensure, remove, getPath, runHook };
}
