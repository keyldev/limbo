import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Тесты движка не требуют предварительной сборки model
    alias: { '@loadline/model': fileURLToPath(new URL('../model/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
