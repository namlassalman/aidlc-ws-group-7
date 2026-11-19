# UAT Dataset: Seven Weeks, Four Doctors, Leave and Overlaps

> **Owner:** Wei Min (Quality). **Loaded and checked:** 2026-11-19 on branch `ui-refresh`, on a
> fresh local server. **Result:** loaded with no problems, and every overlap and leave check
> passed. A second run on the same server added nothing.
>
> The example data in `vision.md` covers one week, and Chen Li is on leave for all of it, so a
> doctor UAT sees almost nothing. This dataset covers the two weeks before the example week of
> 7 Dec and the four weeks after it, with leave for every doctor in every state and the cases
> where things overlap. Each doctor gets a real roster to look at, week by week. The week of
> 7 Dec is still exactly the `vision.md` week, so its roster still matches the vision.

## 1. Load it

Locally:

```bash
PORT=3000 npm start                      # terminal 1: a fresh server (empty in-memory tables)
bash quality/uat/load-uat-data.sh        # terminal 2: loads through the API, checks, prints each doctor's view
```

On the deployed site, with sign-in tokens copied from the browser (how to copy one:
`quality/system-test-cases.md` B.1). Type the tokens at the prompt so they never land in a file
or your shell history:

```bash
export MODE=deployed BASE='https://<the SiteUrl output>'
read -rs COORD_TOKEN && export COORD_TOKEN    # coord1: required
read -rs ASHA_TOKEN  && export ASHA_TOKEN     # asha.rao
read -rs BEN_TOKEN   && export BEN_TOKEN      # ben.ochieng
read -rs CHEN_TOKEN  && export CHEN_TOKEN     # chen.li
read -rs DANA_TOKEN  && export DANA_TOKEN     # dana.novak
bash quality/uat/load-uat-data.sh
```

Each doctor asks for their own leave, so a doctor with no token has their leave skipped (the
loader says so), and the late-leave and overlap checks for Ben and Chen need their tokens.
Tokens expire after an hour. On the deployed site the server uses its own clock, so a week that
starts within 12 hours keeps its current doctors when it is published again.

Everything goes through the real API: the coordinator sets things up and each doctor asks for
their own leave. The load itself is therefore a test of the Units working together.

**Running it again.** The loader only adds what is missing. It skips doctors (409), duties with
the same date, type and modality, rules of a type that already exists, and leave with the same
doctor and dates, so it runs on top of the deployed one-week seed. It always generates and
publishes again. On a second run Ben's 17 Dec leave is known before generating, so from the week
of 14 Dec on, a duty or two can move between doctors. The tables below are from the first run on
an empty server.

## 2. What it contains

| What | Content |
|---|---|
| Weeks | Mon 2026-11-23 to Sun 2027-01-10 (7 weeks). 23 Nov to 3 Jan published (6 weeks); the week of 4 Jan left as a draft |
| Doctors | Rao (consultant; CT, MRI), Ochieng (resident; CT, XR), Li (resident; US, XR), Novak (consultant; MRI, US); 40 hours a week each |
| Duties | 96: the week of 7 Dec is the 6 `vision.md` duties; the other six weeks repeat a 15-duty pattern (below) |
| Rules | rest after call (hard); prefer residents on XR (soft); at most 1 CALL per week (hard); stay within weekly hours (soft); spread CALL duties evenly (soft) |

The weekly pattern, used every week except 7 Dec:

| Day | Duties |
|---|---|
| Mon | AM CT (2, needs consultant), PM MRI (needs consultant), CALL XR |
| Tue | AM US and AM XR (**same time**), PM CT |
| Wed | AM MRI (needs consultant), PM US, CALL CT |
| Thu | AM XR, PM XR |
| Fri | AM CT, PM US, CALL MRI (needs consultant) |
| Sat | CALL XR (weekend call) |

### Leave

| Doctor | Dates | Status | What it tests |
|---|---|---|---|
| Asha Rao | 11-26 to 11-27 | approved | a consultant away before the example week |
| Chen Li | 11-30 to 12-01 | rejected | rejected leave does not block |
| Dana Novak | 12-03 | approved | one day of leave |
| Chen Li | 12-07 to 12-09 | approved | the `vision.md` leave: Chen is off the whole week of 7 Dec |
| Chen Li | 12-15 | rejected | rejected leave does not block |
| Asha Rao | 12-17 to 12-18 | approved | a consultant away: the other consultant must cover |
| Ben Ochieng | 12-17 | approved **after publishing** | late leave: the published week is regenerated automatically |
| Ben Ochieng | 12-22 | cancelled by Ben | a cancelled request does not block |
| Chen Li | 12-24 to 12-26 | approved | leave in the middle of a week |
| Chen Li | 12-25 to 12-27 | **refused (409)** | overlaps her own approved leave |
| Dana Novak | 12-27 to 12-29 | approved | leave **across a week boundary** (Sun 27 Dec to Tue 29 Dec) |
| Ben Ochieng | 12-28 to 12-29 | pending | pending leave does not block |
| Chen Li | 12-29 to 12-30 | **refused (409)** | overlaps her own pending request |
| Chen Li | 12-30 | pending | pending leave does not block |
| Ben Ochieng | 01-05 to 01-06 | approved | leave in the draft week |
| Chen Li | 01-08 | pending | pending leave in the draft week |

### Checks the loader runs

| Check | Result |
|---|---|
| leave overlapping a doctor's own approved leave is refused | 409, as expected |
| leave overlapping a doctor's own pending request is refused | 409, as expected |
| nobody holds two duties at the same time (such as Tue AM US and AM XR), all 7 weeks | passed |
| no doctor has an AM and a PM duty on the same day, all 7 weeks | passed |
| no doctor has more than one CALL in a week (hard rule), all 7 weeks | passed |
| no doctor is placed on a day of their approved leave, all 7 weeks (draft included) | passed |
| the week of 7 Dec has its one `vision.md` gap (8 Dec AM XR) | passed |
| Ben's late leave on 12-17 takes him off his published 12-17 PM XR, with no manual regenerate | passed |

## 3. What each doctor sees (published weeks, first run)

| Doctor | 11-23 | 11-30 | 12-07 | 12-14 | 12-21 | 12-28 | Total |
|---|---|---|---|---|---|---|---|
| Asha Rao | 11-23 AM CT, 11-24 PM CT, 11-25 AM MRI, 11-25 CALL CT | 11-30 AM CT, 12-01 PM CT, 12-02 CALL CT, 12-04 AM CT | 12-07 AM CT, 12-08 AM MRI | 12-14 AM CT, 12-15 PM CT, 12-16 CALL CT | 12-21 AM CT, 12-22 PM CT, 12-23 CALL CT, 12-25 AM CT | 12-28 AM CT, 12-29 PM CT, 12-30 CALL CT, 01-01 AM CT | 21 |
| Ben Ochieng | 11-23 AM CT, 11-24 AM XR, 11-26 PM XR, 11-27 AM CT, 11-28 CALL XR | 11-30 AM CT, 12-01 AM XR, 12-03 PM XR, 12-05 CALL XR | 12-07 AM CT, 12-07 CALL XR, 12-09 PM XR | 12-14 AM CT, 12-15 AM XR, 12-18 AM CT, 12-19 CALL XR | 12-21 AM CT, 12-22 AM XR, 12-24 AM XR, 12-26 CALL XR | 12-28 AM CT, 12-29 AM XR, 12-31 PM XR, 01-02 CALL XR | 24 |
| **Chen Li** | 11-23 CALL XR, 11-25 PM US, 11-26 AM XR, 11-27 PM US | 11-30 CALL XR, 12-02 PM US, 12-03 AM XR, 12-04 PM US | none (leave) | 12-14 CALL XR, 12-16 PM US, 12-17 AM XR, 12-18 PM US | 12-21 CALL XR, 12-23 PM US | 12-28 CALL XR, 12-30 PM US, 12-31 AM XR, 01-01 PM US | 18 |
| Dana Novak | 11-23 PM MRI, 11-24 AM US, 11-27 CALL MRI | 11-30 PM MRI, 12-01 AM US, 12-02 AM MRI, 12-04 CALL MRI | 12-08 AM US | 12-14 PM MRI, 12-15 AM US, 12-16 AM MRI, 12-18 CALL MRI | 12-21 PM MRI, 12-22 AM US, 12-23 AM MRI, 12-25 PM US, 12-25 CALL MRI | 12-30 AM MRI, 01-01 CALL MRI | 19 |

Things to notice:
- **Rao is off 26 and 27 Nov**, so Novak takes the Friday 11-27 CALL MRI, which needs a consultant.
- **Chen works on 12-15 only as the night before:** her 12-14 CALL means rest after call keeps her
  off the morning of 12-15, even though her leave for that day was rejected.
- **Chen is off 12-24 to 12-26** (Christmas leave) and the week is still covered.
- **Ben came off 12-17 PM XR** after his late leave, and that place is the week's unfilled place.
- **Novak is off 12-28 and 12-29**, so she has only two duties in the week of 28 Dec.
- **Novak's PM US and CALL MRI on 12-25** are allowed together: PM ends at 18:00 and CALL starts at
  18:00, so they do not overlap, and a CALL is not a daytime duty.
- **Chen's pending 12-30 leave does not block:** she is on 12-30 PM US.

Coverage report per week (coordinator):

| Week | Published | Unfilled | Broken soft rules | Hours (of 40): Rao / Ochieng / Li / Novak |
|---|---|---|---|---|
| 11-23 | yes | 0 | 0 | 29 / 34 / 29 / 24 |
| 11-30 | yes | 0 | 0 | 29 / 29 / 29 / 29 |
| 12-07 | yes | 1 (12-08 AM XR) | 0 | 10 / 24 / 0 / 5 |
| 12-14 | yes | 1 (12-17 PM XR, after Ben's late leave) | 1 | 24 / 29 / 29 / 29 |
| 12-21 | yes | 1 | 2 | 29 / 29 / 19 / 34 |
| 12-28 | yes | 2 | 0 | 29 / 29 / 29 / 19 |
| 01-04 | draft only | 0 gaps, 16 places filled | — | doctors see "not published yet" |

## 4. Exploring it yourself (local server)

While the server is running, ask the API as any user. For example, as Chen:

```bash
H='-H X-User-Id:chen.li -H X-User-Role:doctor'
curl -s $H 'http://127.0.0.1:3000/api/roster/mine?from=2026-11-23&to=2027-01-10' | jq '.[] | "\(.duty.date) \(.duty.type) \(.duty.modality)"'
curl -s $H 'http://127.0.0.1:3000/api/leave' | jq '.[] | select(.doctorId=="chen.li") | {startDate, endDate, status}'
curl -s $H 'http://127.0.0.1:3000/api/roster/weeks/2026-11-30' | jq '.placements | length'
curl -s $H 'http://127.0.0.1:3000/api/roster/weeks/2027-01-04'        # 404: the week of 4 Jan is not published
```

As the coordinator, use `-H X-User-Id:coord1 -H X-User-Role:coordinator`, for example
`.../api/roster/weeks/2026-12-21/coverage` or `.../api/roster/weeks/2027-01-04?version=draft`.

The RPA robot (`quality/rpa/`) loads this same dataset into its own server on port 3100.
RPA-11 checks Chen's four duties in the week of 14 Dec, and RPA-12 checks that the week of
4 Jan shows "not published yet".
