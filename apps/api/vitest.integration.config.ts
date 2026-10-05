import { defineConfig } from 'vitest/config';
import { workspaceAlias } from '../../vitest.shared';

export default defineConfig({
  resolve: { alias: workspaceAlias },
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 180000,
    fileParallelism: false,
    pool: 'forks',
  },
});
