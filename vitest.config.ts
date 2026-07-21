import { defineConfig } from "vitest/config";

// Root test suite lives in `test/`. Without this config, vitest's default
// file discovery walks the whole repo tree and picks up `web/src/**/*.test.tsx`
// too — those tests need the `web` workspace's own jsdom environment and are
// run separately via `npm --prefix web run test`. Excluding `web/` here keeps
// the two suites independent.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "web/**", "workspaces/**"],
  },
});
