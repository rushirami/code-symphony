import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createTaskStore } from "../src/db/store.js";
import { useTmpDir } from "./helpers.js";

const CLI = path.resolve(import.meta.dirname, "../src/cli/index.ts");

interface CliResult { stdout: string; stderr: string; code: number }

function runCli(args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): CliResult {
  try {
    const stdout = execFileSync("npx", ["tsx", CLI, ...args], {
      encoding: "utf-8",
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
    });
    return { stdout, stderr: "", code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.status ?? 1 };
  }
}

describe("symphony CLI", () => {
  it("add creates the db and task; list and show display it", async () => {
    const dir = await useTmpDir();
    const env = { SYMPHONY_DB: path.join(dir, "tasks.db") };

    const add = runCli(["add", "Fix login bug", "-d", "Users **cannot** log in", "-p", "1", "-l", "bug,auth", "--state", "Todo"], { env });
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("TASK-1");

    const list = runCli(["list"], { env });
    expect(list.stdout).toContain("TASK-1");
    expect(list.stdout).toContain("Todo");
    expect(list.stdout).toContain("urgent");

    const show = runCli(["show", "TASK-1"], { env });
    expect(show.stdout).toContain("Fix login bug");
    expect(show.stdout).toContain("Users **cannot** log in");
    expect(show.stdout).toContain("bug");
  });

  it("done sets state and records the note as a comment; history shows the trail", async () => {
    const dir = await useTmpDir();
    const env = { SYMPHONY_DB: path.join(dir, "tasks.db") };
    runCli(["add", "Ship it", "--state", "Todo"], { env });
    const done = runCli(["done", "TASK-1", "--note", "## Summary\nAll green", "--author", "agent:TASK-1"], { env });
    expect(done.code).toBe(0);

    const store = createTaskStore(path.join(dir, "tasks.db"));
    expect(store.getTask("TASK-1")!.state).toBe("Done");
    expect(store.getComments("TASK-1")[0].body).toBe("## Summary\nAll green");
    expect(store.getComments("TASK-1")[0].author).toBe("agent:TASK-1");
    store.close();

    const history = runCli(["history", "TASK-1"], { env });
    expect(history.stdout).toContain("state_changed");
    expect(history.stdout).toContain("Todo → Done");
  });

  it("rejects invalid states and unknown tasks with exit 1 and an actionable message", async () => {
    const dir = await useTmpDir();
    const env = { SYMPHONY_DB: path.join(dir, "tasks.db") };
    runCli(["add", "x"], { env });

    const bad = runCli(["state", "TASK-1", "Completed"], { env });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Unknown state "Completed"');
    expect(bad.stderr).toContain("Backlog, Todo, In Progress, In Review, Done, Cancelled");

    const missing = runCli(["show", "TASK-99"], { env });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No task with identifier "TASK-99"');

    const unknownCmd = runCli(["frobnicate"], { env });
    expect(unknownCmd.code).toBe(1);
  });

  it("block prevents nothing locally but records the relation; unblock removes it", async () => {
    const dir = await useTmpDir();
    const env = { SYMPHONY_DB: path.join(dir, "tasks.db") };
    runCli(["add", "first"], { env });
    runCli(["add", "second"], { env });
    expect(runCli(["block", "TASK-2", "--by", "TASK-1"], { env }).code).toBe(0);
    const store = createTaskStore(path.join(dir, "tasks.db"));
    expect(store.getTask("TASK-2")!.blockedBy.map((b) => b.identifier)).toEqual(["TASK-1"]);
    store.close();
    expect(runCli(["unblock", "TASK-2", "--by", "TASK-1"], { env }).code).toBe(0);
  });

  it("resolves db path and prefix from the nearest WORKFLOW.md when no flag or env is set", async () => {
    const dir = await useTmpDir();
    await writeFile(path.join(dir, "WORKFLOW.md"), `---
tracker:
  kind: sqlite
  db_path: ./data/my-tasks.db
  identifier_prefix: SYM
---
body
`, "utf-8");
    await mkdir(path.join(dir, "data"), { recursive: true });
    const sub = path.join(dir, "data");
    const env = { SYMPHONY_DB: "" }; // must not win when empty
    const add = runCli(["add", "hello"], { cwd: sub, env });
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("SYM-1");
    const store = createTaskStore(path.join(dir, "data", "my-tasks.db"));
    expect(store.getTask("SYM-1")!.title).toBe("hello");
    store.close();
  });

  it("edit updates title/description/priority; comment appends a markdown comment", async () => {
    const dir = await useTmpDir();
    const env = { SYMPHONY_DB: path.join(dir, "tasks.db") };
    runCli(["add", "Original", "--state", "Todo"], { env });
    expect(runCli(["edit", "TASK-1", "--title", "Renamed", "-d", "New **body**", "-p", "2"], { env }).code).toBe(0);
    expect(runCli(["comment", "TASK-1", "A `markdown` note", "--author", "rushi"], { env }).code).toBe(0);
    const store = createTaskStore(path.join(dir, "tasks.db"));
    const t = store.getTask("TASK-1")!;
    expect(t.title).toBe("Renamed");
    expect(t.description).toBe("New **body**");
    expect(t.priority).toBe(2);
    expect(store.getComments("TASK-1").map((c) => c.body)).toContain("A `markdown` note");
    store.close();
    const show = runCli(["show", "TASK-1"], { env });
    expect(show.stdout).toContain("Renamed");
    expect(show.stdout).toContain("A `markdown` note");
  });

  it("list --all includes terminal states; --label filters", async () => {
    const dir = await useTmpDir();
    const env = { SYMPHONY_DB: path.join(dir, "tasks.db") };
    runCli(["add", "open one", "--state", "Todo", "-l", "bug"], { env });
    runCli(["add", "closed one", "--state", "Todo"], { env });
    runCli(["done", "TASK-2"], { env });
    const dflt = runCli(["list"], { env });
    expect(dflt.stdout).toContain("TASK-1");
    expect(dflt.stdout).not.toContain("TASK-2");
    const all = runCli(["list", "--all"], { env });
    expect(all.stdout).toContain("TASK-2");
    const byLabel = runCli(["list", "--label", "bug"], { env });
    expect(byLabel.stdout).toContain("TASK-1");
    expect(byLabel.stdout).not.toContain("TASK-2");
  }, 15000);

  it("rejects an unaliased short flag and does not silently apply the command", async () => {
    const dir = await useTmpDir();
    const env = { SYMPHONY_DB: path.join(dir, "tasks.db") };
    runCli(["add", "Ship it", "--state", "Todo"], { env });

    const bad = runCli(["done", "TASK-1", "-n", "sneaky note"], { env });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('-n');
    expect(bad.stderr).toContain("done");

    // The command must NOT have taken effect: task still not Done, no comment recorded.
    const store = createTaskStore(path.join(dir, "tasks.db"));
    expect(store.getTask("TASK-1")!.state).not.toBe("Done");
    expect(store.getComments("TASK-1")).toHaveLength(0);
    store.close();
  });

  it("rejects an unknown long flag naming the offending flag", async () => {
    const dir = await useTmpDir();
    const env = { SYMPHONY_DB: path.join(dir, "tasks.db") };
    const bad = runCli(["add", "x", "--labl", "bug"], { env });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--labl");
    expect(bad.stderr).toContain("add");
  });

  it("rejects extra positional arguments", async () => {
    const dir = await useTmpDir();
    const env = { SYMPHONY_DB: path.join(dir, "tasks.db") };
    runCli(["add", "x", "--state", "Todo"], { env });
    const bad = runCli(["state", "TASK-1", "Done", "extra"], { env });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("extra");
    // And a flag not allowed for this command is rejected too (author/db still allowed).
    expect(runCli(["show", "TASK-1", "--note", "x"], { env }).code).toBe(1);
    expect(runCli(["show", "TASK-1", "--author", "rushi"], { env }).code).toBe(0);
  });
});
