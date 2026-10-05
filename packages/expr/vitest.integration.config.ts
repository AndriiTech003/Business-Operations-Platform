import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  test: { include: ['test/**/*.int.test.ts'], testTimeout: 60000, hookTimeout: 60000 },
});
