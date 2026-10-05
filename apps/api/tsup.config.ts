import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/app.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: true,
  external: [/^@prisma\//, 'playwright', 'pg', '@aws-sdk/client-s3'],
});
