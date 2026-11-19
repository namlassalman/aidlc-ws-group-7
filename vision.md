# Vision: Radiology Roster

## What we are building and for whom

A small web application for the radiology department of a mid-sized hospital.
The department has about 20 radiologists, consultants and residents (doctors
in training), who cover reporting duties across CT, MRI, ultrasound, and
general X-ray, plus overnight and weekend call duty. Today the roster
coordinator builds the duty roster for each four-week period by hand in a
spreadsheet, which takes most of two days. Leave requests arrive by email, and
gaps are found only when a duty has no one on it. The coordinator says this
causes three problems: doctors are rostered on days they have approved leave,
duties are given to doctors who are not trained for that modality, and nobody
can see which duties are still short of cover until the week before.

The application replaces the spreadsheet for one department. The roster
coordinator keeps the list of doctors, sets up the duties that need cover,
decides leave requests, and sets the **rules** the roster must follow. The
application then **generates the roster** for a period. The coordinator
reviews the draft and publishes it. Doctors use the application to request
leave and to see their own roster.

## Who uses it

| Role | Can do |
|---|---|
| **Coordinator** | Everything: manage doctors, duties and rules, decide leave, generate, review and publish the roster, see every report |
| **Doctor** | Request and cancel their own leave, see their own duties and the published roster |

Users sign in with a username and password (Amazon Cognito). Their role comes
from the Cognito group they belong to: `coordinator` or `doctor`. Test users
are created by the integration lead; there is no self sign-up.

## How it runs

The application runs on AWS, in the integration lead's workshop account:

- **The roster page**, one web page, shows the roster for a week: each day's
  duties with their doctors. The coordinator can also generate a draft for a
  period, see its gaps and the reasons, and publish it. It is the screen used
  in the demo.
- **The API** behind it does everything in the five features below. Features
  without a screen are used through the API, and their effect shows on the
  roster page.

## Rules the roster follows

Four checks always apply and cannot be switched off. A doctor is never put on
a duty when:

- they are not trained for the duty's modality;
- they have approved leave on the duty's date;
- they already have a duty that overlaps in time;
- the duty needs a consultant and they are a resident, unless a consultant is
  already on it.

On top of those, the coordinator creates **rules**. Each rule has a type, its
settings, and is either **hard** (never broken) or **soft** (followed when
possible). It can be switched off without deleting it. The first release has
these rule types:

| Rule type | Example | Usually |
|---|---|---|
| **Modality assignment** | "Dr Rao reports MRI only"; "prefer residents on XR" | Hard or soft |
| **Duty limit** | "At most 2 `CALL` duties per doctor per week" | Hard |
| **Rest after call** | "No `AM` duty the morning after a `CALL`" | Hard |
| **Weekly hours** | "Stay within each doctor's maximum hours per week" | Soft |
| **Consultant cover** | "Every MRI duty has at least one consultant" | Hard |
| **Fair share** | "Spread `CALL` duties evenly across doctors" | Soft |

## In the first release

1. **Doctors.** The coordinator adds, edits, and deactivates doctors. Each
   doctor has a name, a grade (`consultant` or `resident`), the modalities
   they are trained for (any of `CT`, `MRI`, `US`, `XR`), and a maximum number
   of hours per week. Doctors can see the list of active doctors.
2. **Duties.** The coordinator creates the duties that need cover for a roster
   period. A duty has a date, a type (`AM` 08:00 to 13:00, `PM` 13:00 to
   18:00, or `CALL`, overnight call duty, 18:00 to 08:00 the next day), a
   modality, the number of doctors needed (1 to 3), and whether it needs a
   consultant. The coordinator can list duties by date range and cancel a duty.
3. **Leave.** A doctor requests leave for a date range, with an optional
   reason. The coordinator approves or rejects it. A doctor can cancel their
   own request while it is still pending. Everyone can see approved leave;
   only the coordinator and the requesting doctor can see pending and rejected
   requests.
4. **Rules.** The coordinator creates, edits, switches on and off, and deletes
   rules of the types above, and lists the rules in effect. A rule is refused,
   with a message, when its settings are invalid (for example a modality a
   named doctor is not trained for) or when it contradicts another hard rule.
   For any doctor and duty, the coordinator can ask "can this doctor take this
   duty?" and get yes or no, with every rule that decides it. Optionally, if
   the group chooses it, a rules panel on the roster page lists the rules and
   lets the coordinator switch each one on or off, then regenerate.
5. **Roster.** For a roster period, the coordinator **generates** a draft: the
   application puts doctors on every duty, following the always-on checks and
   every hard rule, and as many soft rules as it can. The same inputs always
   give the same roster. Every place it cannot fill is listed with the reason
   (for example "no consultant trained in MRI is free on 2026-12-08 `AM`").
   The coordinator can regenerate after changing rules, duties or leave, and
   then **publishes** the draft. For a date range, anyone can see the
   published roster by day and a doctor's own roster. The coordinator also
   sees a coverage report: unfilled places, broken soft rules, and each
   doctor's hours per week against their maximum. This feature owns the
   **roster page**.

## Not in the first release

- Editing a generated roster by hand, swapping duties between doctors, or
  doctors choosing their own duties. The coordinator changes rules, duties or
  leave and regenerates instead
- Rule types other than the six above, and rules written as free text
- Optimising across several periods, or learning from past rosters
- Public holiday rules
- Notifications by email, chat, or pager
- Links to payroll, HR, or hospital systems
- More than one department or hospital
- Any real staff data, and self sign-up. Use made-up names only
- Screens other than the roster page and its optional rules panel
- Custom domain names, more than one environment, and a deployment pipeline

## Open questions

- When a hard rule makes a duty impossible to fill, should generation leave
  the place empty and say why (the first release assumes this), or refuse to
  generate at all?
- When two soft rules pull in different directions, which wins? Should the
  coordinator be able to rank them?
- What happens to a published roster when leave is approved later for a doctor
  on it: flagged for the coordinator, or regenerated automatically?
- Does publishing lock the period, so a later generate makes a new draft rather
  than changing what doctors already see?
- Can a doctor be given an `AM` and a `PM` duty on the same day? (The first
  release assumes yes, because they do not overlap.)
- Is a `CALL` duty counted against the date it starts or the date it ends, for
  leave and rest checks?

## Example data for testing

Made up, and small enough to type. The deployed app is loaded with it, so the
roster page has something to show:

- Doctors: Dr Asha Rao (consultant; CT, MRI), Dr Ben Ochieng (resident;
  CT, XR), Dr Chen Li (resident; US, XR), Dr Dana Novak (consultant; MRI, US)
- Duties, week of 2026-12-07:
  - 2026-12-07 `AM` CT, needs 2, needs a consultant
  - 2026-12-07 `CALL` XR, needs 1
  - 2026-12-08 `AM` MRI, needs 1, needs a consultant
  - 2026-12-08 `AM` US, needs 1
  - 2026-12-08 `AM` XR, needs 1
  - 2026-12-09 `PM` XR, needs 1
- Leave: Dr Chen Li, 2026-12-07 to 2026-12-09, approved
- Rules:
  - Rest after call, hard: no `AM` duty the morning after a `CALL`
  - Modality assignment, soft: prefer residents on XR
  - Duty limit, hard: at most 1 `CALL` duty per doctor per week
- Expected when generated, every place filled except one:
  - Dr Chen Li is on nothing that week (leave)
  - 2026-12-07 `AM` CT: Dr Asha Rao and Dr Ben Ochieng
  - 2026-12-07 `CALL` XR: Dr Ben Ochieng, the only XR-trained doctor free
  - 2026-12-08 `AM` US: Dr Dana Novak, the only US-trained doctor free
  - 2026-12-08 `AM` MRI: Dr Asha Rao. A generator that fills MRI first with
    Dr Novak leaves US empty; filling the hardest place first avoids that
  - 2026-12-08 `AM` XR: not filled. Dr Ben Ochieng is the only XR-trained
    doctor free, and the rest rule keeps him off the morning after his `CALL`.
    With the rest rule switched off, he fills it
  - 2026-12-09 `PM` XR: Dr Ben Ochieng (soft rule: residents on XR)
- Sign-in usernames: `coord1` (coordinator); `asha.rao`, `ben.ochieng`,
  `chen.li`, `dana.novak` (doctors, matching the doctors above)

## Note for facilitators

The five features map to five Units, one per group member, after a walking
skeleton: doctors, duties, leave, rules, roster. The skeleton must create
every DynamoDB table and index, the table helpers with an in-memory version
for tests, the whole AWS stack, the roster page shell, and the **rule
checker** in `src/shared/rules.ts`: the rule types and one function that says
whether a doctor can take a duty, applying the always-on checks and the rules
it is given. Rules and Roster both use it, so neither depends on the other's
code. Then every feature can read the tables it needs and test with seeded
items.

Roster is the largest Unit: generation, draft and publish, the coverage
report, and the only page. The group decides who builds it; it should be a
developer, and it is claimed first. Rules is the second largest. If the
integration lead takes Roster, a second developer or a group facilitator
should be ready to help, because the lead also merges and deploys every Unit.

If a group finishes early, add stretch goals in a second piece of work, after
Build and Test: editing a draft by hand with the rules checked, or ranking
soft rules.
