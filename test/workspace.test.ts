import { describe, it, expect } from "vitest";
import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { createWorkspaceManager } from "../src/workspace/manager.js";
import { useTmpDir, makeIssue } from "./helpers.js";
import type { WorkspaceConfig } from "../src/types.js";

const log = pino({ level: "silent" });

function makeWsConfig(root: string, hooks: Partial<WorkspaceConfig["hooks"]> = {}): WorkspaceConfig {
  return {
    root,
    hooks: {
      timeoutMs: 5000,
      ...hooks,
    },
  };
}

describe("WorkspaceManager", () => {
  it("ensure creates directory and returns absolute path", async () => {
    const root = await useTmpDir();
    const wm = createWorkspaceManager(makeWsConfig(root), log);
    const issue = makeIssue({ identifier: "PROJ-1" });

    const wsPath = await wm.ensure(issue);

    expect(path.isAbsolute(wsPath)).toBe(true);
    const s = await stat(wsPath);
    expect(s.isDirectory()).toBe(true);
  });

  it("ensure is idempotent", async () => {
    const root = await useTmpDir();
    const wm = createWorkspaceManager(
      makeWsConfig(root, { afterCreate: "echo created > .hook-ran" }),
      log,
    );
    const issue = makeIssue({ identifier: "PROJ-1" });

    const path1 = await wm.ensure(issue);
    const path2 = await wm.ensure(issue);

    expect(path1).toBe(path2);

    // Hook marker should exist (created on first ensure)
    const marker = await readFile(path.join(path1, ".hook-ran"), "utf-8");
    expect(marker.trim()).toBe("created");
  });

  it("sanitizes identifiers", async () => {
    const root = await useTmpDir();
    const wm = createWorkspaceManager(makeWsConfig(root), log);

    const wsPath = await wm.ensure(makeIssue({ identifier: "PROJ-123" }));
    expect(path.basename(wsPath)).toBe("proj-123");

    const wsPath2 = await wm.ensure(
      makeIssue({ identifier: "Weird/Chars!", id: "uuid-2" }),
    );
    expect(path.basename(wsPath2)).toBe("weird_chars_");
  });

  it("rejects path traversal attempts", async () => {
    const root = await useTmpDir();
    const wm = createWorkspaceManager(makeWsConfig(root), log);

    // After sanitization, "../" becomes ".._" which is safe
    // But let's test getPath directly with a crafted identifier
    // The sanitizer replaces / with _ so traversal is blocked
    const wsPath = wm.getPath("../../escape");
    // The sanitized name is ".._.._escape" which stays under root
    expect(wsPath.startsWith(root)).toBe(true);
  });

  it("runs after_create hook only on first creation", async () => {
    const root = await useTmpDir();
    const wm = createWorkspaceManager(
      makeWsConfig(root, {
        afterCreate: 'count=$(cat .count 2>/dev/null || echo 0); echo $((count + 1)) > .count',
      }),
      log,
    );
    const issue = makeIssue({ identifier: "PROJ-1" });

    const wsPath = await wm.ensure(issue);
    await wm.ensure(issue); // second call

    const count = await readFile(path.join(wsPath, ".count"), "utf-8");
    expect(count.trim()).toBe("1"); // hook only ran once
  });

  it("before_run hook failure throws", async () => {
    const root = await useTmpDir();
    const wm = createWorkspaceManager(
      makeWsConfig(root, { beforeRun: "exit 1" }),
      log,
    );
    const issue = makeIssue({ identifier: "PROJ-1" });
    const wsPath = await wm.ensure(issue);

    await expect(wm.runHook("beforeRun", wsPath)).rejects.toThrow("Hook beforeRun failed");
  });

  it("after_run hook failure does not throw", async () => {
    const root = await useTmpDir();
    const wm = createWorkspaceManager(
      makeWsConfig(root, { afterRun: "exit 1" }),
      log,
    );
    const issue = makeIssue({ identifier: "PROJ-1" });
    const wsPath = await wm.ensure(issue);

    // Should not throw
    await wm.runHook("afterRun", wsPath);
  });

  it("remove deletes the directory", async () => {
    const root = await useTmpDir();
    const wm = createWorkspaceManager(makeWsConfig(root), log);
    const issue = makeIssue({ identifier: "PROJ-1" });

    const wsPath = await wm.ensure(issue);
    await wm.remove("PROJ-1");

    await expect(stat(wsPath)).rejects.toThrow();
  });

  it("remove runs before_remove hook", async () => {
    const root = await useTmpDir();
    const wm = createWorkspaceManager(
      makeWsConfig(root, { beforeRemove: "echo removing > ../remove-marker" }),
      log,
    );
    const issue = makeIssue({ identifier: "PROJ-1" });

    await wm.ensure(issue);
    await wm.remove("PROJ-1");

    const marker = await readFile(path.join(root, "remove-marker"), "utf-8");
    expect(marker.trim()).toBe("removing");
  });

  it("hook timeout kills the process", async () => {
    const root = await useTmpDir();
    const wm = createWorkspaceManager(
      makeWsConfig(root, { beforeRun: "sleep 30", timeoutMs: 500 }),
      log,
    );
    const issue = makeIssue({ identifier: "PROJ-1" });
    const wsPath = await wm.ensure(issue);

    await expect(wm.runHook("beforeRun", wsPath)).rejects.toThrow();
  }, 10_000);
});
