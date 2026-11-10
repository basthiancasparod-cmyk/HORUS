import { defineConfig } from '@playwright/test';

/**
 * HORUS — Playwright end-to-end suite (tests-e2e/).
 *
 * Runs the real app in a real browser, served locally with
 * `node tools/serve.mjs` (no build step). Every test runs in local mode
 * ("Usar sin cuenta"): no account, no Supabase writes, no network beyond
 * localhost. See tests-e2e/README.md.
 */
export default defineConfig({
  testDir: './tests-e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // Phone-width viewport: HORUS is a mobile-first PWA, and on a narrow
    // screen Calendar / Shifts / Hours live under the "Más" menu.
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tools/serve.mjs 5173',
    url: 'http://127.0.0.1:5173/',
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
