import { expect, test } from '@playwright/test';
import {
  assignShift,
  completeOnboarding,
  gotoApp,
  goToView,
  midMonthDate,
} from './helpers';

/**
 * H-09 / H-10 — Hours totals and export.
 * A morning shift (08:30-17:00 = 8h 30m) assigned to one member must show
 * up in the Hours view, and the export preview must list it.
 */
test('H-09 hours view totals the assigned morning shift', async ({ page }) => {
  await gotoApp(page);
  await completeOnboarding(page);
  const date = midMonthDate();

  await assignShift(page, 'Ana Ruiz', date, 'Mañana');

  await goToView(page, 'hours');
  const table = page.locator('#hours-table');
  await expect(table).toBeVisible();
  await expect(table).toContainText('Ana Ruiz');
  // 08:30-17:00 is 8 hours 30 minutes for that one day.
  await expect(table).toContainText(/8h 30|8,5|8\.5/);
});

test('H-10 export dialog CSV preview contains the assigned shift', async ({ page }) => {
  await gotoApp(page);
  await completeOnboarding(page);
  const date = midMonthDate();

  await assignShift(page, 'Luis Peña', date, 'Mañana');

  await goToView(page, 'calendar');
  await page.click('#calendar-export');
  await expect(page.locator('#dialog-export[open]')).toBeVisible();
  await expect(page.locator('#export-formats')).toContainText('CSV para Excel');

  await page.locator('#export-formats .setting-row', { hasText: 'CSV para Excel' }).click();
  const preview = page.locator('#export-preview');
  await expect(preview).toContainText('Luis Peña');
  await expect(preview).toContainText('M');
});
