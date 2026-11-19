# RPA Test Cases: the Radiology Roster page (AI-DLC Hospital)

> **Owner:** Wei Min (Quality). **Written and run:** 2026-11-19 on branch `ui-refresh` (the AI-DLC
> Hospital redesign). **Tool:** Playwright (browser robot), in `quality/rpa/` with its own
> `package.json`; the app's `package.json` is untouched.
> **Result, local mode: 13 of 13 passed.** Deployed mode: not run yet (needs the site address and
> test passwords from Wafi).

## 1. What the robot does

It opens the real page in a Chromium browser, signs in, and clicks and reads the page the way a
person would, using the page's `data-testid` attributes. Every case saves a screenshot.

| Mode | Page | Sign-in | API and data | When |
|---|---|---|---|---|
| `local` | the real `web/` files | a stand-in for Cognito that returns straight to the page as the chosen user | the real API on a fresh local server (port 3100), loaded with the seven-week UAT dataset (23 Nov to 10 Jan) (`quality/uat-data.md`) through the API | any time; no AWS needed |
| `deployed` | the real site (`SITE_URL`) | the real Cognito managed login, typing the username and password | the deployed API and DynamoDB, with `npm run seed` loaded | after each deploy |

Local mode changes nothing in `web/`. It serves the page files as they are and forwards the
page's `/api` calls to the local API as the signed-in user.

## 2. Run it

```bash
cd quality/rpa
npm install                        # once: Playwright for the robot only
npx playwright install chromium    # once: the browser
sudo npx playwright install-deps chromium   # once per machine, if the browser reports missing libraries

npm run test:local                 # starts its own API server and loads the data; ~15 s
npm run report                     # opens the HTML report with every screenshot
```

Deployed mode (Wafi, or anyone with the test users' passwords; the passwords stay in the
shell, never in a file):

```bash
cd quality/rpa
export RPA_MODE=deployed SITE_URL='https://<the SiteUrl output>'
read -rs RPA_COORD_PASSWORD && export RPA_COORD_PASSWORD   # coord1
read -rs RPA_BEN_PASSWORD   && export RPA_BEN_PASSWORD     # ben.ochieng
read -rs RPA_CHEN_PASSWORD  && export RPA_CHEN_PASSWORD    # chen.li
npm run test:deployed
```

Before a deployed run: `npm run seed`, and each test user has signed in once and set a
permanent password (Cognito asks for a new password on first sign-in, which the robot does not
handle). Cases tagged `@local-only` (RPA-11, RPA-12) are skipped on the deployed site, because the
deployed seed has only the example week (unless the seven-week loader has been run there too: `quality/uat-data.md`).

## 3. Cases

### Branding and layout

| Id | User | Steps | Expected | Result (local) |
|---|---|---|---|---|
| RPA-01 | Ben | open the page; scroll down | title starts "Radiology Roster"; the logo mark, "AI-DLC Hospital" and "Radiology Roster" show in the header; the header is sticky and stays at the top after scrolling; the logo gradient runs `#4A00FF` to `#FF00FF` | PASS |
| RPA-02 | Ben | open the page at 390 × 844 (phone) | logo and name visible; the subtitle hides; **the page never scrolls sideways** (only the grid scrolls inside its card) | PASS |

### Coordinator

| Id | User | Steps | Expected | Result (local) |
|---|---|---|---|---|
| RPA-03 | coord1 | open the page | "Signed in: coord1 (Coordinator)"; Generate and Publish; the side panel with the Rules tab | PASS |
| RPA-04 | coord1 | week of 12-07, Weeks 1, Generate | status shows DRAFT; Tue 12-08 AM XR shows "[!] UNFILLED", "suggested: Dr Ben Ochieng" and the rest-after-call reason; Mon 12-07 AM CT shows Rao and Ochieng | PASS |
| RPA-05 | coord1 | open the Rules tab; switch "rest after call" off; Generate; switch it on; Generate | with the rule off, Ochieng fills 12-08 AM XR; with it back on, the place is unfilled again | PASS |
| RPA-06 | coord1 | Generate; Publish; Cancel; Publish; Confirm | the confirmation names the 12-hour lock; Cancel leaves the DRAFT; Confirm shows PUBLISHED | PASS |
| RPA-07 | coord1 | Next; Previous | the label moves to the week of 12-14 and back; the address keeps `?week=` | PASS |

### Doctor

| Id | User | Steps | Expected | Result (local) |
|---|---|---|---|---|
| RPA-08 | Chen | open the page | "Signed in: chen.li (Doctor)"; no Generate, Publish or side panel; "Only my duties" shown; the roster uses the full width | PASS |
| RPA-09 | Chen | week of 12-07 | PUBLISHED; Chen is nowhere in the grid (her leave week); 12-08 AM XR shows UNFILLED with no suggestion | PASS |
| RPA-10 | Ben | week of 12-07; tick and untick "Only my duties" | three places marked "(you)"; ticked, only those three show and no UNFILLED; unticked, all places return | PASS |
| RPA-11 `@local-only` | Chen | week of 12-14; tick "Only my duties" | four places marked "(you)" (12-14 CALL XR, 12-16 PM US, 12-17 AM XR, 12-18 PM US); ticked, only those four | PASS |
| RPA-12 `@local-only` | Chen | week of 01-04 (draft only) | "This week is not published yet." and no grid | PASS |

### Session

| Id | User | Steps | Expected | Result (local) |
|---|---|---|---|---|
| RPA-13 | Chen | Sign out | the browser goes to the sign-out address (`/logout`) | PASS |

## 4. What the runs found and fixed

| What | Fix |
|---|---|
| On a phone, the week grid pushed the whole page sideways | the grid now scrolls inside its card; RPA-02 checks the page never scrolls sideways |
| On a doctor's screen, the grid used two thirds of the width (space kept for the coordinator panel, which doctors don't have) | the roster takes the full width when there is no panel; RPA-08 checks it |
| Empty days were squeezed and their headings wrapped | seven equal day columns |
| The panel opens on the Gaps tab, so the rule switches are hidden until Rules is clicked | not a defect: RPA-05 clicks the Rules tab first, as a person would |

Still open from the approved mockup, not fixed here (it needs `web/features/roster.js`, the
Roster Unit's file): on phones the mockup asks for a day-by-day list instead of the grid.

## 5. Selectors the robot relies on

Header: `shell-header`, `shell-brand`, `shell-brand-logo`, `shell-brand-name`, `shell-brand-sub`,
`shell-signed-in`, `shell-sign-out-button`. Week picker: `week-picker`, `week-picker-prev-button`,
`week-picker-label`, `week-picker-next-button`. Roster: `roster-root`, `roster-toolbar`,
`roster-status`, `roster-weeks-select`, `roster-generate-button`, `roster-publish-button`,
`roster-publish-dialog`, `roster-publish-dialog-text`, `roster-publish-confirm-button`,
`roster-publish-cancel-button`, `roster-grid`, `roster-duty` (with `data-duty-id`), `roster-place`
(with `data-duty-id`, `data-state`), `roster-only-mine-checkbox`, `roster-message`. Panel: `panel`,
`panel-tab-rules`, `rule-toggle-<rule id>`.

Renaming any of these breaks the robot; change the robot in the same commit.
