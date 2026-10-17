import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The package's "main" points at a CJS file inside a "type": "module" package;
    // use its ES build directly so Node-side tests load it correctly.
    alias: {
      '@dimforge/rapier3d-deterministic-compat': fileURLToPath(new URL('./node_modules/@dimforge/rapier3d-deterministic-compat/rapier.es.js', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180000,
    hookTimeout: 60000,
    pool: 'forks',
  },
});
