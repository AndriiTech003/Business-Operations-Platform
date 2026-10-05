import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  external: ['@ashamrai/realtime-server'],
  clean: true,
  sourcemap: true,
});
