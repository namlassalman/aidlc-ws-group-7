#!/usr/bin/env bash
# Loads a richer UAT dataset into the LOCAL server, through the real API, then prints what each
# doctor sees. Dataset and expected behaviour: quality/uat-data.md.
#
#   PORT=3000 npm start                     # terminal 1: a fresh server (empty in-memory tables)
#   bash quality/uat/load-uat-data.sh       # terminal 2
#
# Four weeks (Mon 2026-12-07 to Sun 2027-01-03), the four example doctors, 51 duties, leave for
# every doctor (approved, pending, rejected, cancelled, across a week boundary, and one approved
# after publishing), five rules, and the "overlap" cases the system must refuse or handle.
# Week 1 is exactly the vision.md example week, so its roster still matches the vision.
set -u

BASE="${BASE:-http://127.0.0.1:3000}"
NOW='"now":"2026-12-01T00:00:00.000Z"'   # honoured by the local server only: nothing is locked
LAST_STATUS=""
LAST_BODY=""
PROBLEMS=0

call() {
  local id="$1" role="$2" method="$3" path="$4" body="${5:-}" out
  if [ -n "$body" ]; then
    out=$(curl -s -w '\n%{http_code}' -X "$method" -H "X-User-Id: $id" -H "X-User-Role: $role" \
      -H 'Content-Type: application/json' --data "$body" "$BASE$path")
  else
    out=$(curl -s -w '\n%{http_code}' -X "$method" -H "X-User-Id: $id" -H "X-User-Role: $role" "$BASE$path")
  fi
  LAST_STATUS="${out##*$'\n'}"
  LAST_BODY="${out%$'\n'*}"
}
coord() { call coord1 coordinator "$@"; }
as_doc() { local who="$1"; shift; call "$who" doctor "$@"; }

# expect <status> <what>: report and count anything unexpected
expect() {
  if [ "$LAST_STATUS" = "$1" ]; then
    printf '  ok   %-4s %s\n' "$1" "$2"
  else
    PROBLEMS=$((PROBLEMS + 1))
    printf '  FAIL %-4s %s (wanted %s: %s)\n' "$LAST_STATUS" "$2" "$1" "${LAST_BODY:0:200}"
  fi
}
id_of() { printf '%s' "$LAST_BODY" | jq -r .id; }

curl -s -o /dev/null "$BASE/api/me" || { echo "No server at $BASE: run 'PORT=3000 npm start' first."; exit 2; }
coord GET "/api/doctors?all=true"
if [ "$(printf '%s' "$LAST_BODY" | jq 'length')" != "0" ]; then
  echo "The server already has data: restart 'npm start' for a clean load."; exit 2
fi

echo "== Doctors =="
for d in \
  '{"id":"asha.rao","name":"Dr Asha Rao","grade":"consultant","modalities":["CT","MRI"],"maxHoursPerWeek":40}' \
  '{"id":"ben.ochieng","name":"Dr Ben Ochieng","grade":"resident","modalities":["CT","XR"],"maxHoursPerWeek":40}' \
  '{"id":"chen.li","name":"Dr Chen Li","grade":"resident","modalities":["US","XR"],"maxHoursPerWeek":40}' \
  '{"id":"dana.novak","name":"Dr Dana Novak","grade":"consultant","modalities":["MRI","US"],"maxHoursPerWeek":40}'; do
  coord POST /api/doctors "$d"; expect 201 "add $(printf '%s' "$d" | jq -r .name)"
done

echo "== Duties =="
duty() { # duty <date> <type> <modality> <needed> <consultant>
  coord POST /api/duties "{\"date\":\"$1\",\"type\":\"$2\",\"modality\":\"$3\",\"doctorsNeeded\":$4,\"needsConsultant\":$5}"
  [ "$LAST_STATUS" = "201" ] || { PROBLEMS=$((PROBLEMS + 1)); echo "  FAIL duty $1 $2 $3: $LAST_STATUS ${LAST_BODY:0:200}"; }
}
# Week 1: the vision.md example week, unchanged.
duty 2026-12-07 AM CT 2 true;  duty 2026-12-07 CALL XR 1 false
duty 2026-12-08 AM MRI 1 true; duty 2026-12-08 AM US 1 false; duty 2026-12-08 AM XR 1 false
duty 2026-12-09 PM XR 1 false
# Weeks 2 to 4: the same 15-duty pattern each week (Mon to Sat).
for mon in 2026-12-14 2026-12-21 2026-12-28; do
  d() { date -d "$mon + $1 day" +%F; }
  duty "$(d 0)" AM CT 2 true;  duty "$(d 0)" PM MRI 1 true;  duty "$(d 0)" CALL XR 1 false
  duty "$(d 1)" AM US 1 false; duty "$(d 1)" AM XR 1 false; duty "$(d 1)" PM CT 1 false
  duty "$(d 2)" AM MRI 1 true; duty "$(d 2)" PM US 1 false; duty "$(d 2)" CALL CT 1 false
  duty "$(d 3)" AM XR 1 false; duty "$(d 3)" PM XR 1 false
  duty "$(d 4)" AM CT 1 false; duty "$(d 4)" PM US 1 false; duty "$(d 4)" CALL MRI 1 true
  duty "$(d 5)" CALL XR 1 false
done
coord GET "/api/duties?from=2026-12-07&to=2027-01-03"
echo "  ok        $(printf '%s' "$LAST_BODY" | jq length) duties over four weeks"

echo "== Rules =="
coord POST /api/rules '{"type":"rest_after_call","strength":"hard","settings":{}}'; expect 201 "rest after call (hard)"
coord POST /api/rules '{"type":"modality_assignment","strength":"soft","settings":{"who":{"grade":"resident"},"modalities":["XR"],"mode":"preferOn"}}'; expect 201 "prefer residents on XR (soft)"
coord POST /api/rules '{"type":"duty_limit","strength":"hard","settings":{"dutyType":"CALL","max":1,"per":"week"}}'; expect 201 "at most 1 CALL per doctor per week (hard)"
coord POST /api/rules '{"type":"weekly_hours","strength":"soft","settings":{}}'; expect 201 "stay within weekly hours (soft)"
coord POST /api/rules '{"type":"fair_share","strength":"soft","settings":{"dutyType":"CALL"}}'; expect 201 "spread CALL duties evenly (soft)"

echo "== Leave =="
leave() { # leave <doctor> <start> <end> <reason>; sets LEAVE_ID
  as_doc "$1" POST /api/leave "{\"startDate\":\"$2\",\"endDate\":\"$3\",\"reason\":\"$4\"}"
  LEAVE_ID=$(id_of)
}
leave chen.li 2026-12-07 2026-12-09 "conference";  expect 201 "Chen requests 12-07..12-09"
coord POST "/api/leave/$LEAVE_ID/approve";          expect 200 "  approved (the vision.md leave)"
leave chen.li 2026-12-24 2026-12-26 "Christmas";    expect 201 "Chen requests 12-24..12-26"
coord POST "/api/leave/$LEAVE_ID/approve";          expect 200 "  approved"
leave chen.li 2026-12-25 2026-12-27 "extended";     expect 409 "Chen's request overlapping her own approved leave is refused"
leave chen.li 2026-12-15 2026-12-15 "course";       expect 201 "Chen requests 12-15"
coord POST "/api/leave/$LEAVE_ID/reject";           expect 200 "  rejected (she still works 12-15)"
leave chen.li 2026-12-30 2026-12-30 "appointment";  expect 201 "Chen requests 12-30, left pending (does not block)"
leave asha.rao 2026-12-17 2026-12-18 "exam board";  expect 201 "Rao requests 12-17..12-18"
coord POST "/api/leave/$LEAVE_ID/approve";          expect 200 "  approved"
leave dana.novak 2026-12-27 2026-12-29 "travel";    expect 201 "Novak requests 12-27..12-29 (across the week 3 / week 4 boundary)"
coord POST "/api/leave/$LEAVE_ID/approve";          expect 200 "  approved"
leave ben.ochieng 2026-12-22 2026-12-22 "dentist";  expect 201 "Ben requests 12-22"
as_doc ben.ochieng POST "/api/leave/$LEAVE_ID/cancel"; expect 200 "  cancelled by Ben (he still works 12-22)"
leave ben.ochieng 2026-12-28 2026-12-29 "family";   expect 201 "Ben requests 12-28..12-29, left pending (does not block)"

echo "== Roster: generate four weeks, publish the first three =="
coord POST /api/roster/generate "{\"weekStart\":\"2026-12-07\",\"weeks\":4,$NOW}"; expect 200 "generate 12-07 + 4 weeks"
coord POST /api/roster/publish "{\"weekStart\":\"2026-12-07\",\"weeks\":3,$NOW}"; expect 200 "publish weeks 1-3 (week 4 stays a draft)"

echo "== Late leave: approved after publishing =="
mine_week2() {
  as_doc ben.ochieng GET "/api/roster/mine?from=2026-12-14&to=2026-12-20"
  printf '%s' "$LAST_BODY" | jq -r '[.[] | "\(.duty.date[5:]) \(.duty.type) \(.duty.modality)"] | join(", ")'
}
echo "  Ben's published week 2 before: $(mine_week2)"
leave ben.ochieng 2026-12-17 2026-12-17 "sick";     expect 201 "Ben requests 12-17 (a day he is rostered) after publishing"
coord POST "/api/leave/$LEAVE_ID/approve";          expect 200 "  approved: week 2 is regenerated and republished"
printf '  follow-ups: %s\n' "$(printf '%s' "$LAST_BODY" | jq -c '.followUps')"
AFTER=$(mine_week2)
echo "  Ben's published week 2 after:  $AFTER"
case "$AFTER" in
  *12-17*) PROBLEMS=$((PROBLEMS + 1)); echo "  FAIL      Ben is still rostered on 12-17" ;;
  *) echo "  ok        Ben is off 12-17 without anyone regenerating by hand" ;;
esac

echo "== Overlap cases the system must handle =="
as_doc chen.li POST /api/leave '{"startDate":"2026-12-26","endDate":"2026-12-28"}'
expect 409 "Chen: leave overlapping her approved Christmas leave"
as_doc chen.li POST /api/leave '{"startDate":"2026-12-29","endDate":"2026-12-30"}'
expect 409 "Chen: leave overlapping her own pending 12-30 request"
coord GET "/api/duties?from=2026-12-15&to=2026-12-15"
TUE_US=$(printf '%s' "$LAST_BODY" | jq -r '.[] | select(.type=="AM" and .modality=="US") | .id')
TUE_XR=$(printf '%s' "$LAST_BODY" | jq -r '.[] | select(.type=="AM" and .modality=="XR") | .id')
coord GET /api/roster/weeks/2026-12-14
WEEK2="$LAST_BODY"
both=$(printf '%s' "$WEEK2" | jq --arg us "$TUE_US" --arg xr "$TUE_XR" \
  '[.placements[] | select(.dutyId == $us)][0].doctorId as $a | [.placements[] | select(.dutyId == $xr)][0].doctorId as $b | ($a != null and $a == $b)')
if [ "$both" = "false" ]; then echo "  ok        nobody holds both 12-15 AM US and 12-15 AM XR (same time)"; else PROBLEMS=$((PROBLEMS+1)); echo "  FAIL      one doctor holds two 12-15 AM duties"; fi
daytime=$(printf '%s' "$WEEK2" | jq '[.placements[] as $p | .duties[] | select(.id == $p.dutyId and .type != "CALL") | {doc: $p.doctorId, date}] | group_by(.doc + .date) | map(length) | max')
if [ "${daytime:-0}" -le 1 ]; then echo "  ok        no doctor has two daytime duties (AM and PM) on one day in week 2"; else PROBLEMS=$((PROBLEMS+1)); echo "  FAIL      a doctor has $daytime daytime duties on one day"; fi
calls=$(printf '%s' "$WEEK2" | jq '[.placements[] as $p | .duties[] | select(.id == $p.dutyId and .type == "CALL") | $p.doctorId] | group_by(.) | map(length) | max // 0')
if [ "${calls:-0}" -le 1 ]; then echo "  ok        no doctor has more than one CALL in week 2 (hard duty limit)"; else PROBLEMS=$((PROBLEMS+1)); echo "  FAIL      a doctor has $calls CALLs in week 2"; fi

# No doctor is placed on a day of their approved leave, in any of the four weeks (draft included).
coord GET /api/leave
APPROVED=$(printf '%s' "$LAST_BODY" | jq -c '[.[] | select(.status == "approved") | {doctorId, startDate, endDate}]')
clashes=0
for wk in 2026-12-07 2026-12-14 2026-12-21 2026-12-28; do
  version=published; [ "$wk" = "2026-12-28" ] && version=draft
  coord GET "/api/roster/weeks/$wk?version=$version"
  n=$(printf '%s' "$LAST_BODY" | jq --argjson leave "$APPROVED" '
    [.placements[] as $p | .duties[] | select(.id == $p.dutyId) | {doc: $p.doctorId, date}
     | select(. as $x | any($leave[]; .doctorId == $x.doc and .startDate <= $x.date and $x.date <= .endDate))] | length')
  clashes=$((clashes + n))
done
if [ "$clashes" -eq 0 ]; then echo "  ok        no doctor is placed on a day of their approved leave (weeks 1-4)"; else PROBLEMS=$((PROBLEMS+1)); echo "  FAIL      $clashes placements fall on approved leave"; fi

echo
echo "================ What each doctor sees, week by week ================"
for doc in asha.rao ben.ochieng chen.li dana.novak; do
  echo
  echo "## $doc"
  as_doc "$doc" GET "/api/roster/mine?from=2026-12-07&to=2027-01-03"
  printf '%s' "$LAST_BODY" | jq -r '
    def monday: strptime("%Y-%m-%d") | mktime | . - ((((strftime("%u") | tonumber) - 1)) * 86400) | strftime("%Y-%m-%d");
    group_by(.duty.date | monday)
    | map("  week of Mon " + (.[0].duty.date | monday) + ": " + (map("\(.duty.date[5:]) \(.duty.type) \(.duty.modality)") | join(", ")))
    | .[]' 2>/dev/null
  n=$(printf '%s' "$LAST_BODY" | jq length)
  [ "$n" = "0" ] && echo "  (no published duties)"
  echo "  published duties in weeks 1-3: $n"
  as_doc "$doc" GET "/api/leave"
  printf '%s' "$LAST_BODY" | jq -r --arg me "$doc" '
    map(select(.doctorId == $me)) | sort_by(.startDate)
    | if length == 0 then "  leave: none" else .[] | "  leave: \(.startDate)..\(.endDate) \(.status) (\(.reason // "-"))" end'
done

echo
echo "================ Coverage per week (coordinator) ================"
for wk in 2026-12-07 2026-12-14 2026-12-21; do
  coord GET "/api/roster/weeks/$wk/coverage"
  printf '%s' "$LAST_BODY" | jq -r --arg wk "$wk" '
    "  \($wk) published: \(.unfilled | length) unfilled, \(.brokenSoftRules | length) broken soft rules, \(.lockedClashes | length) clashes; hours " +
    (.hours | map("\(.doctorId) \(.hours)/\(.max // "-")") | join(", "))'
done
coord GET "/api/roster/weeks/2026-12-28?version=draft"
printf '%s' "$LAST_BODY" | jq -r '"  2026-12-28 draft only: \(.placements | length) places filled, \(.gaps | length) gaps (doctors see \"not published yet\")"'

echo
if [ "$PROBLEMS" -eq 0 ]; then echo "Loaded with no problems."; else echo "Loaded with $PROBLEMS problem(s): see FAIL lines."; fi
[ "$PROBLEMS" -eq 0 ]
