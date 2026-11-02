import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**', 'dist/**'],
    // Validates the environment before any test module is imported.
    setupFiles: ['tests/setup-env.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
