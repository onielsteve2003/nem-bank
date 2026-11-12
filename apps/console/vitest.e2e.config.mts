import { defineConfig } from 'vitest/config';

// Live end-to-end run against a real API (see e2e/live.e2e.ts); not used by `pnpm test`.
export default defineConfig({
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') } },
  test: { environment: 'node', include: ['e2e/**/*.e2e.ts'], testTimeout: 120_000 },
});
