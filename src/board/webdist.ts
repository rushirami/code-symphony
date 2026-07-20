import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

// src/board/ or dist/board/ → repo root → web/
export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

/**
 * Returns the path to the built frontend, building it on first use so a fresh
 * clone works with one command. Returns undefined (board API still runs, UI
 * unavailable) when the build is skipped or fails.
 */
export function ensureWebDist(log: Logger, webDir: string = WEB_DIR): string | undefined {
  const dist = path.join(webDir, "dist");
  if (existsSync(path.join(dist, "index.html"))) return dist;
  if (process.env.SYMPHONY_NO_WEB_BUILD === "1") {
    log.warn("web/dist missing and SYMPHONY_NO_WEB_BUILD=1; board UI unavailable");
    return undefined;
  }
  if (!existsSync(path.join(webDir, "package.json"))) {
    log.warn({ webDir }, "web/ not found; board UI unavailable");
    return undefined;
  }
  if (!existsSync(path.join(webDir, "node_modules"))) {
    log.info("Installing board UI dependencies (one-time)");
    if (spawnSync("npm", ["install", "--prefix", webDir], { stdio: "inherit" }).status !== 0) {
      log.error("npm install for web/ failed; board UI unavailable");
      return undefined;
    }
  }
  log.info("Building board UI (one-time)");
  if (spawnSync("npm", ["run", "build", "--prefix", webDir], { stdio: "inherit" }).status !== 0) {
    log.error("web build failed; board UI unavailable");
    return undefined;
  }
  return existsSync(path.join(dist, "index.html")) ? dist : undefined;
}
