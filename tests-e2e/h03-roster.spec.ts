import { expect, test } from '@playwright/test';
import {
  assignShift,
  completeOnboarding,
  entriesFor,
  gotoApp,
  goToView,
  midMonthDate,
  memberIdByName,
  readDoc,
  readStoredDoc,
} from './helpers';

/**
 * H-04 / H-05 / H-06 — Roster: assign, undo, and clear a shift.
 * All through the real UI; the stored document in localStorage is the
 * assertion source of truth, plus what the roster cell shows.
 */
test('H-04 assign a morning shift in the roster', async ({ page }) => {
  await gotoApp(page);
  await completeOnboarding(page);
  const date = midMonthDate();

  await assignShift(page, 'Luis Peña', date, 'Mañana');

  const entries = await entriesFor(page, 'Luis Peña', date);
  expect(entries).toHaveLength(1);
  const doc = await readDoc(page);
  const type = doc.shiftTypes.find((t) => t.id === entries[0].typeId);
  expect(type?.code).toBe('M');

  const memberId = await memberIdByName(page, 'Luis Peña');
  const cell = page.locator(
    `td.shift-cell[data-date="${date}"][data-member-id="${memberId}"]`,
  );
  await expect(cell).toContainText('M');

  // The app persists with a 350 ms debounce: the entry must land in
  // localStorage shortly after the UI already shows it.
  await expect
    .poll(async () => {
      const stored = await readStoredDoc(page);
      return stored.entries.filter((e) => e.memberId === memberId && e.date === date);
    })
    .toHaveLength(1);
});

test('H-05 assign a night shift, then undo removes it', async ({ page }) => {
  await gotoApp(page);
  await completeOnboarding(page);
  const date = midMonthDate();

  await assignShift(page, 'Marta Gil', date, 'Noche');
  expect(await entriesFor(page, 'Marta Gil', date)).toHaveLength(1);

  await page.click('#btn-undo');
  await expect
    .poll(() => entriesFor(page, 'Marta Gil', date), { timeout: 5_000 })
    .toHaveLength(0);
});

test('H-06 clearing a shift with "Sin turno" removes the entry', async ({ page }) => {
  await gotoApp(page);
  await completeOnboarding(page);
  const date = midMonthDate();

  await assignShift(page, 'Luis Peña', date, 'Tarde');
  expect(await entriesFor(page, 'Luis Peña', date)).toHaveLength(1);

  // Open the same cell again and pick "Sin turno".
  await assignShift(page, 'Luis Peña', date, 'Sin turno');
  expect(await entriesFor(page, 'Luis Peña', date)).toHaveLength(0);
});
