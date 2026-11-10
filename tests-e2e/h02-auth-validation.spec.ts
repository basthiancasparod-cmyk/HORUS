import { expect, test } from '@playwright/test';
import { gotoApp } from './helpers';

/**
 * H-02 / H-03 — Auth form validation (negative paths).
 * Both checks happen client-side, before any network request, so they
 * run with Supabase blocked and no account involved.
 */
test('H-02 sign-in with an invalid email shows a validation error', async ({ page }) => {
  await gotoApp(page);

  await page.fill('#auth-email', 'not-an-email');
  await page.fill('#auth-password', '123456');
  await page.click('#auth-submit');

  const error = page.locator('#auth-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Ese email no parece válido.');
  // Still on the auth screen: nothing was submitted anywhere.
  await expect(page.locator('#auth-screen:not([hidden])')).toBeVisible();
});

test('H-03 sign-in with a short password shows a validation error', async ({ page }) => {
  await gotoApp(page);

  await page.fill('#auth-email', 'ana@trabajo.com');
  await page.fill('#auth-password', '123');
  await page.click('#auth-submit');

  const error = page.locator('#auth-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('al menos 6 caracteres');
  await expect(page.locator('#auth-screen:not([hidden])')).toBeVisible();
});
