import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/main/core/**/*.test.ts', 'src/main/electron/**/*.test.ts', 'src/renderer/src/lib/**/*.test.ts', 'src/renderer/src/components/**/*.test.ts', 'src/renderer/src/features/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
