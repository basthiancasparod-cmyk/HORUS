import { expect, test } from '@playwright/test';
import { completeOnboarding, gotoApp, readDoc } from './helpers';

/**
 * H-01 — First run: auth screen, "use without an account", setup wizard.
 * The app works with no account at all; the wizard creates the user and
 * the team locally, and the app opens on the Today view.
 */
test('H-01 onboarding completes and opens the app with the team', async ({ page }) => {
  await gotoApp(page);

  // The default cloud project is configured, so the first screen is auth.
  await expect(page.locator('#auth-screen:not([hidden])')).toBeVisible();
  await expect(page.locator('#auth-cloud-state')).toContainText('sincronizan');

  await completeOnboarding(page, 'Ana Ruiz', ['Luis Peña', 'Marta Gil']);

  await expect(page.locator('#view-today')).toBeVisible();
  await expect(page.locator('#today-date')).not.toBeEmpty();

  const doc = await readDoc(page);
  expect(doc.settings.firstRun).toBe(false);
  expect(doc.members.map((m) => m.name)).toEqual(['Ana Ruiz', 'Luis Peña', 'Marta Gil']);
  // The default shift catalogue ships with the document.
  expect(doc.shiftTypes.map((t) => t.code)).toEqual([
    'M',
    'T',
    'INT',
    'N',
    'P',
    'RE',
    'V',
    'B',
    'L',
    'F',
  ]);
});
