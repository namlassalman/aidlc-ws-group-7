// Shared robot steps: signing in (locally or through Cognito), finding duties and places on the
// week grid, and the page's main controls, by their data-testid.
import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import { localDutyId, useLocalSite } from "./local-site";
import type { RpaUser } from "./users";

export const isDeployed = () => process.env.RPA_MODE === "deployed";

/** Opens a new browser session signed in as `user`, on the week of `weekStart`. */
export async function signIn(browser: Browser, user: RpaUser, weekStart: string): Promise<Page> {
  const context = await browser.newContext();
  if (!isDeployed()) await useLocalSite(context, user);
  const page = await context.newPage();
  await page.goto(`/?week=${weekStart}`);
  if (isDeployed()) await cognitoSignIn(page, user);
  await expect(page.getByTestId("shell-signed-in")).toContainText(user.id);
  await expect(page.getByTestId("roster-toolbar")).toBeVisible();
  return page;
}

/** Fills Cognito's managed login page (one-step or two-step username and password). */
async function cognitoSignIn(page: Page, user: RpaUser): Promise<void> {
  const password = process.env[user.passwordEnv];
  if (!password) throw new Error(`set ${user.passwordEnv} to sign in as ${user.id}`);
  const username = page.locator('input[name="username"]:visible').first();
  await username.waitFor();
  await username.fill(user.id);
  const passwordField = page.locator('input[name="password"]:visible').first();
  if (!(await passwordField.isVisible())) {
    await page
      .locator('button[type="submit"]:visible, input[type="submit"]:visible')
      .first()
      .click();
  }
  await passwordField.waitFor();
  await passwordField.fill(password);
  await page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first().click();
}

/** The id of a duty: the seed's fixed id on AWS, looked up on the local API otherwise. */
export async function dutyId(date: string, type: string, modality: string): Promise<string> {
  if (isDeployed()) return `d-${date}-${type.toLowerCase()}-${modality.toLowerCase()}`;
  return localDutyId(date, type, modality);
}

export const duty = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="roster-duty"][data-duty-id="${id}"]`);

export const places = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="roster-place"][data-duty-id="${id}"]`);

/** Waits until the grid is drawn for the week and the toolbar is idle. */
export async function gridReady(page: Page): Promise<void> {
  await expect(page.getByTestId("roster-grid")).toBeVisible();
  const generate = page.getByTestId("roster-generate-button");
  if (await generate.count()) await expect(generate).toHaveText("Generate");
}

export async function generateWeek(page: Page): Promise<void> {
  await page.getByTestId("roster-weeks-select").selectOption("1");
  await page.getByTestId("roster-generate-button").click();
  await expect(page.getByTestId("roster-generate-button")).toHaveText("Generate");
  await gridReady(page);
}

export async function publishWeek(page: Page): Promise<void> {
  await page.getByTestId("roster-publish-button").click();
  await expect(page.getByTestId("roster-publish-dialog")).toBeVisible();
  await page.getByTestId("roster-publish-confirm-button").click();
  await expect(page.getByTestId("roster-publish-button")).toHaveText("Publish");
  await expect(page.getByTestId("roster-status")).toHaveText("PUBLISHED");
}
