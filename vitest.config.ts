import { defineConfig } from 'vitest/config';

// The game simulation is pure TypeScript (no DOM), so tests run in the fast
// node environment. Kept separate from vite.config.ts so the React/Tailwind
// plugins don't load during test runs.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
