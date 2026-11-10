import { expect, test } from '@playwright/test';
import {
  assignShift,
  completeOnboarding,
  gotoApp,
  goToView,
  midMonthDate,
} from './helpers';

/**
 * H-07 / H-08 — Calendar month view: an assigned shift shows as a bar
 * on the right day, and month navigation moves the period.
 */
test('H-07 calendar month shows the assigned shift on its day', async ({ page }) => {
  await gotoApp(page);
  await completeOnboarding(page);
  const date = midMonthDate();

  await assignShift(page, 'Luis Peña', date, 'Mañana');

  await goToView(page, 'calendar');
  const cell = page.locator(`button.month-cell[data-date="${date}"]`);
  await expect(cell).toBeVisible();
  await expect(cell.locator('.cell-bar')).toHaveCount(1);
  // The bar shows the member's initials; the full shift is in the cell's
  // title ("Luis Peña 08:30–17:00") and aria-label ("1 turno").
  await expect(cell).toHaveAttribute('title', /Luis Peña 08:30–17:00/);
  await expect(cell).toHaveAttribute('aria-label', /1 turno/);
});

test('H-08 calendar month navigation moves forward and back', async ({ page }) => {
  await gotoApp(page);
  await completeOnboarding(page);

  await goToView(page, 'calendar');
  const title = page.locator('#calendar-title');
  const current = (await title.textContent()) ?? '';

  await page.click('#calendar-next');
  await expect.poll(async () => title.textContent()).not.toBe(current);

  await page.click('#calendar-prev');
  await expect.poll(async () => title.textContent()).toBe(current);
});
