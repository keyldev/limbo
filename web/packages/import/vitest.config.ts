import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Тесты импорта не требуют предварительной сборки model и engine
    alias: {
      '@loadline/model': fileURLToPath(new URL('../model/src/index.ts', import.meta.url)),
      '@loadline/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
