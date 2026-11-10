import { expect, type Page } from '@playwright/test';

export const APP_URL = 'http://127.0.0.1:5173/';
export const DOC_KEY = 'horus.doc.v4';

export interface HorusMember {
  id: string;
  name: string;
}

export interface HorusEntry {
  id: string;
  memberId: string;
  date: string;
  typeId: string | null;
}

export interface HorusDoc {
  members: HorusMember[];
  entries: HorusEntry[];
  shiftTypes: { id: string; code: string; label: string }[];
  settings: { firstRun: boolean };
}

/**
 * Open the app with the test environment applied:
 * - the service worker is stubbed out, so its one-time reload on first
 *   install cannot interrupt a test mid-flow (offline/PWA behaviour is
 *   out of scope for this suite; the app itself is untouched);
 * - Google Fonts and Supabase are blocked: the suite runs fully local and
 *   must never depend on, or write to, any remote service.
 */
export async function gotoApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.route('**/fonts.googleapis.com/**', (route) => route.abort());
  await page.route('**/fonts.gstatic.com/**', (route) => route.abort());
  await page.route('**/*.supabase.co/**', (route) => route.abort());
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await expect(
    page
      .locator(
        '#auth-screen:not([hidden]), #wizard-screen:not([hidden]), #app:not([hidden])',
      )
      .first(),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Walk the real first-run flow: auth screen -> "Usar sin cuenta" ->
 * 3-step setup wizard -> app. Leaves the app open on the Today view
 * with the given team in local mode.
 */
export async function completeOnboarding(
  page: Page,
  name = 'Ana Ruiz',
  members: string[] = ['Luis Peña', 'Marta Gil'],
): Promise<void> {
  await page.click('#auth-local');
  await expect(page.locator('#wizard-screen:not([hidden])')).toBeVisible();

  await page.fill('#wizard-name', name);
  await page.click('#wizard-next');
  await expect(page.locator('[data-wizard-step="1"].is-active')).toBeVisible();

  for (const member of members) {
    await page.fill('#wizard-member-input', member);
    await page.click('#wizard-add-member');
    await expect(page.locator('#wizard-members', { hasText: member })).toBeVisible();
  }
  await page.click('#wizard-next');
  await expect(page.locator('[data-wizard-step="2"].is-active')).toBeVisible();

  await page.click('#wizard-next');
  await expect(page.locator('#app:not([hidden])')).toBeVisible({ timeout: 10_000 });
}

/**
 * Read the app's live document (the in-memory store exposed by the app
 * itself for debugging at `window.__HORUS__.doc`). This reflects a change
 * immediately; the localStorage copy lags behind because the app persists
 * with a 350 ms debounce (see `readStoredDoc` for the persisted copy).
 */
export async function readDoc(page: Page): Promise<HorusDoc> {
  const doc = await page.evaluate(() => {
    const horus = (window as unknown as { __HORUS__?: { doc?: unknown } }).__HORUS__;
    if (horus?.doc) return horus.doc as HorusDoc;
    const raw = localStorage.getItem(DOC_KEY);
    if (!raw) throw new Error('no HORUS document in localStorage');
    return JSON.parse(raw) as HorusDoc;
  });
  return doc;
}

/** The document as persisted in localStorage (lags the live store ~350 ms). */
export async function readStoredDoc(page: Page): Promise<HorusDoc> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), DOC_KEY);
  if (!raw) throw new Error('no HORUS document in localStorage');
  return JSON.parse(raw) as HorusDoc;
}

/**
 * Navigate through the real navigation. On a phone-width viewport the app
 * shows four fixed sections (Today, Roster, Team, Settings) and the rest
 * (Calendar, Shifts, Hours) live under the "Más" menu — the secondary nav
 * buttons are `display: none` at desktop width too, so the menu is the
 * reliable path for them at any width.
 */
export async function goToView(
  page: Page,
  view: 'today' | 'roster' | 'team' | 'settings' | 'calendar' | 'shifts' | 'hours',
): Promise<void> {
  const primary = ['today', 'roster', 'team', 'settings'];
  if (primary.includes(view)) {
    await page.locator(`button.nav-item[data-view="${view}"]`).click();
  } else {
    await page.click('#nav-more');
    await page.locator(`.nav-more-item[data-view="${view}"]`).click();
  }
  await expect(page.locator(`#view-${view}:not([hidden])`)).toBeVisible();
}

export async function memberIdByName(page: Page, name: string): Promise<string> {
  const doc = await readDoc(page);
  const member = doc.members.find((m) => m.name === name);
  if (!member) throw new Error(`member not found in document: ${name}`);
  return member.id;
}

/** A date in the middle of the current month, always visible in the roster. */
export function midMonthDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}-15`;
}

/**
 * Assign a shift through the real UI: open the roster, click the member's
 * cell for the date, pick the shift type in the assign dialog, save.
 * `shiftLabel` is the visible chip label, e.g. 'Mañana' or 'Noche'.
 */
export async function assignShift(
  page: Page,
  memberName: string,
  date: string,
  shiftLabel: string,
): Promise<void> {
  const memberId = await memberIdByName(page, memberName);
  await goToView(page, 'roster');
  const cell = page.locator(
    `td.shift-cell[data-date="${date}"][data-member-id="${memberId}"]`,
  );
  await expect(cell).toBeVisible();
  await cell.click();
  await expect(page.locator('#dialog-assign[open]')).toBeVisible();
  await page.locator('#assign-types .chip', { hasText: shiftLabel }).first().click();
  await page.click('#assign-save');
  await expect(page.locator('#dialog-assign[open]')).toHaveCount(0);
}

/** Entries stored for one member on one date (empty when nothing is assigned). */
export async function entriesFor(
  page: Page,
  memberName: string,
  date: string,
): Promise<HorusEntry[]> {
  const doc = await readDoc(page);
  const memberId = await memberIdByName(page, memberName);
  return doc.entries.filter((e) => e.memberId === memberId && e.date === date);
}
