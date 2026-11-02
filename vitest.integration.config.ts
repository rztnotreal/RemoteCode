import { defineConfig } from 'vitest/config';

/**
 * Configuration for REAL integration tests (tests/integration).
 *
 * They invoke the installed `opencode` binary and may spend model credits, so
 * they are opt-in:
 *
 *   npm run test:integration
 *
 * Individual tests skip themselves when the CLI cannot be resolved.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 60_000,
    // The CLI chain is stateful: run files one at a time.
    fileParallelism: false,
  },
});
