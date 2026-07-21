import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import pino from "pino";
import { ensureWebDist } from "../src/board/webdist.js";
import { useTmpDir } from "./helpers.js";

const log = pino({ level: "silent" });

describe("ensureWebDist", () => {
  it("returns dist when index.html already exists", async () => {
    const webDir = await useTmpDir();
    await mkdir(path.join(webDir, "dist"), { recursive: true });
    await writeFile(path.join(webDir, "dist", "index.html"), "x");
    expect(ensureWebDist(log, webDir)).toBe(path.join(webDir, "dist"));
  });

  it("returns undefined when web dir has no package.json", async () => {
    const webDir = await useTmpDir();
    expect(ensureWebDist(log, webDir)).toBeUndefined();
  });

  it("returns undefined without building when SYMPHONY_NO_WEB_BUILD=1", async () => {
    const webDir = await useTmpDir();
    await writeFile(path.join(webDir, "package.json"), "{}");
    process.env.SYMPHONY_NO_WEB_BUILD = "1";
    try {
      expect(ensureWebDist(log, webDir)).toBeUndefined();
    } finally {
      delete process.env.SYMPHONY_NO_WEB_BUILD;
    }
  });
});
