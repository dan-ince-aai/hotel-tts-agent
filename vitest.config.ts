import { defineConfig } from "vitest/config";

/**
 * Tests, deliberately separate from vite.config.ts so the page's React and Tailwind plugins
 * never load for a spec. `globals` matches tsconfig's `vitest/globals`; the agent's own
 * Python tests and agent worktrees are not this suite's.
 */
export default defineConfig({
  test: {
    globals: true,
    reporters: ["default"],
    exclude: ["**/node_modules/**", "dist/**", "agent/**", ".claude/**"],
  },
});
