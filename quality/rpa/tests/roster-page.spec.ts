// RPA test cases for the Radiology Roster page (AI-DLC Hospital). Case ids and expected results:
// quality/rpa-test-cases.md. The robot clicks and reads the page the way a person would, using
// the page's data-testid attributes. Screenshots of every case land in test-results/.
import { expect, test } from "@playwright/test";
import { BEN, CHEN, COORD } from "../support/users";
import {
  duty,
  dutyId,
  generateWeek,
  gridReady,
  isDeployed,
  places,
  publishWeek,
  signIn,
} from "../support/robot";

const WEEK1 = "2026-12-07";
const WEEK2 = "2026-12-14";

test.describe("Branding and layout", () => {
  test("RPA-01 the AI-DLC Hospital header is anchored at the top with the logo", async ({
    browser,
  }) => {
    const page = await signIn(browser, BEN, WEEK1);
    await expect(page).toHaveTitle(/^Radiology Roster/);
    const header = page.getByTestId("shell-header");
    await expect(page.getByTestId("shell-brand-logo")).toBeVisible();
    await expect(page.getByTestId("shell-brand-name")).toHaveText("AI-DLC Hospital");
    await expect(page.getByTestId("shell-brand-sub")).toHaveText("Radiology Roster");

    // Anchored: the header stays at the top of the window after scrolling.
    await expect(header).toHaveCSS("position", "sticky");
    await page.mouse.wheel(0, 2000);
    expect((await header.boundingBox())?.y).toBe(0);

    // Brand colours: the logo gradient runs from blue-violet to magenta.
    const stops = await page
      .locator("#brand-gradient stop")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("stop-color")));
    expect(stops).toEqual(["#4A00FF", "#FF00FF"]);
    await page.screenshot({ path: test.info().outputPath("header.png") });
  });

  test("RPA-02 on a phone-sized screen the header still shows the logo and name", async ({
    browser,
  }) => {
    const page = await signIn(browser, BEN, WEEK1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("shell-brand-logo")).toBeVisible();
    await expect(page.getByTestId("shell-brand-name")).toBeVisible();
    await expect(page.getByTestId("shell-brand-sub")).toBeHidden();
    // The page itself never scrolls sideways; only the grid scrolls inside its card.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath("phone.png"), fullPage: true });
  });
});

test.describe("Coordinator", () => {
  test("RPA-03 the coordinator sees the planning controls and the Rules tab", async ({
    browser,
  }) => {
    const page = await signIn(browser, COORD, WEEK1);
    await expect(page.getByTestId("shell-signed-in")).toHaveText("Signed in: coord1 (Coordinator)");
    await expect(page.getByTestId("roster-generate-button")).toBeVisible();
    await expect(page.getByTestId("roster-publish-button")).toBeVisible();
    await expect(page.getByTestId("panel")).toBeVisible();
    await expect(page.getByTestId("panel-tab-rules")).toBeVisible();
  });

  test("RPA-04 Generate shows the example week with its one gap and suggestion", async ({
    browser,
  }) => {
    const page = await signIn(browser, COORD, WEEK1);
    await gridReady(page);
    await generateWeek(page);
    await expect(page.getByTestId("roster-status")).toContainText("DRAFT");

    const amXr = await dutyId("2026-12-08", "AM", "XR");
    const gap = places(page, amXr);
    await expect(gap).toHaveAttribute("data-state", "unfilled");
    await expect(gap).toContainText("UNFILLED");
    await expect(gap).toContainText("suggested: Dr Ben Ochieng");
    await expect(gap).toContainText(/rest after call/i);

    const amCt = await dutyId("2026-12-07", "AM", "CT");
    await expect(duty(page, amCt)).toContainText("Dr Asha Rao");
    await expect(duty(page, amCt)).toContainText("Dr Ben Ochieng");
    await page.screenshot({
      path: test.info().outputPath("coordinator-draft.png"),
      fullPage: true,
    });
  });

  test("RPA-05 switching a rule off in the Rules tab and generating fills the gap", async ({
    browser,
  }) => {
    const page = await signIn(browser, COORD, WEEK1);
    await gridReady(page);
    // The panel opens on its Gaps tab; open the Rules tab as a person would.
    await page.getByTestId("panel-tab-rules").click();
    await expect(page.getByTestId("panel-tab-rules")).toHaveAttribute("aria-selected", "true");
    const toggle = page.getByTestId("rule-toggle-rule-1-rest-after-call");
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await generateWeek(page);
    const amXr = await dutyId("2026-12-08", "AM", "XR");
    await expect(places(page, amXr)).toHaveAttribute("data-state", "filled");
    await expect(places(page, amXr)).toContainText("Dr Ben Ochieng");

    // Put the rule back so the later cases see the normal roster.
    await toggle.check();
    await expect(toggle).toBeChecked();
    await generateWeek(page);
    await expect(places(page, amXr)).toHaveAttribute("data-state", "unfilled");
  });

  test("RPA-06 Publish asks for confirmation, then shows the week as published", async ({
    browser,
  }) => {
    const page = await signIn(browser, COORD, WEEK1);
    await gridReady(page);
    await generateWeek(page);
    await page.getByTestId("roster-publish-button").click();
    await expect(page.getByTestId("roster-publish-dialog")).toBeVisible();
    await expect(page.getByTestId("roster-publish-dialog-text")).toContainText(
      "Duties starting within 12 hours keep their current doctors",
    );
    await page.getByTestId("roster-publish-cancel-button").click();
    await expect(page.getByTestId("roster-publish-dialog")).toBeHidden();
    await expect(page.getByTestId("roster-status")).toContainText("DRAFT");
    await publishWeek(page);
  });

  test("RPA-07 the week picker moves between weeks and keeps the week in the address", async ({
    browser,
  }) => {
    const page = await signIn(browser, COORD, WEEK1);
    await expect(page.getByTestId("week-picker-label")).toContainText(WEEK1);
    await page.getByTestId("week-picker-next-button").click();
    await expect(page.getByTestId("week-picker-label")).toContainText(WEEK2);
    await expect(page).toHaveURL(new RegExp(`week=${WEEK2}`));
    await page.getByTestId("week-picker-prev-button").click();
    await expect(page.getByTestId("week-picker-label")).toContainText(WEEK1);
  });
});

test.describe("Doctor", () => {
  test("RPA-08 a doctor sees no planning controls and no Rules tab", async ({ browser }) => {
    const page = await signIn(browser, CHEN, WEEK1);
    await expect(page.getByTestId("shell-signed-in")).toHaveText("Signed in: chen.li (Doctor)");
    await expect(page.getByTestId("roster-generate-button")).toHaveCount(0);
    await expect(page.getByTestId("roster-publish-button")).toHaveCount(0);
    // With no coordinator panel, the roster card uses the full width.
    const roster = await page.getByTestId("roster-root").boundingBox();
    const picker = await page.getByTestId("week-picker").boundingBox();
    expect(roster!.width).toBeGreaterThan(picker!.width * 0.95);
    await expect(page.getByTestId("panel")).toBeHidden();
    await expect(page.getByTestId("roster-only-mine-checkbox")).toBeVisible();
  });

  test("RPA-09 Chen is on nothing in her leave week, and sees the gap without a suggestion", async ({
    browser,
  }) => {
    const page = await signIn(browser, CHEN, WEEK1);
    await gridReady(page);
    await expect(page.getByTestId("roster-status")).toHaveText("PUBLISHED");
    await expect(page.getByTestId("roster-grid")).not.toContainText("Dr Chen Li");
    const amXr = await dutyId("2026-12-08", "AM", "XR");
    await expect(places(page, amXr)).toContainText("UNFILLED");
    await expect(places(page, amXr)).not.toContainText("suggested");
    await page.screenshot({ path: test.info().outputPath("chen-week1.png"), fullPage: true });
  });

  test("RPA-10 Ben's own places are marked (you), and Only my duties shows just those", async ({
    browser,
  }) => {
    const page = await signIn(browser, BEN, WEEK1);
    await gridReady(page);
    const mine = page.locator('[data-testid="roster-place"] strong', { hasText: "(you)" });
    await expect(mine).toHaveCount(3);
    await page.getByTestId("roster-only-mine-checkbox").check();
    await expect(page.locator('[data-testid="roster-place"]')).toHaveCount(3);
    await expect(page.getByTestId("roster-grid")).not.toContainText("UNFILLED");
    await page.getByTestId("roster-only-mine-checkbox").uncheck();
    await expect(page.locator('[data-testid="roster-place"]').first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("ben-week1.png"), fullPage: true });
  });

  test("RPA-11 @local-only Chen sees her four duties in the week of 12-14", async ({ browser }) => {
    const page = await signIn(browser, CHEN, WEEK2);
    await gridReady(page);
    const mine = page.locator('[data-testid="roster-place"] strong', { hasText: "(you)" });
    await expect(mine).toHaveCount(4);
    await page.getByTestId("roster-only-mine-checkbox").check();
    await expect(page.locator('[data-testid="roster-place"]')).toHaveCount(4);
    await page.screenshot({ path: test.info().outputPath("chen-week2.png"), fullPage: true });
  });

  test("RPA-12 @local-only a week with only a draft shows 'not published yet' to a doctor", async ({
    browser,
  }) => {
    const page = await signIn(browser, CHEN, "2026-12-28");
    await expect(page.getByTestId("roster-message")).toHaveText("This week is not published yet.");
    await expect(page.getByTestId("roster-grid")).toHaveCount(0);
  });
});

test.describe("Session", () => {
  test("RPA-13 Sign out leaves the page through the sign-out address", async ({ browser }) => {
    const page = await signIn(browser, CHEN, WEEK1);
    await page.getByTestId("shell-sign-out-button").click();
    await expect(page).toHaveURL(isDeployed() ? /\/logout/ : /auth\.test\/logout/);
  });
});
