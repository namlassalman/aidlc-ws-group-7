#!/usr/bin/env bash
# Loads the UAT dataset through the real API, then prints what each doctor sees.
# Dataset and expected behaviour: quality/uat-data.md.
#
# Seven weeks: Mon 2026-11-23 to Sun 2027-01-10 (2 weeks before the vision.md example week of
# 7 Dec, the example week itself, and 4 weeks after). The four example doctors, 96 duties, five
# rules, leave for every doctor in every state, and the overlap cases the system must refuse or
# handle. The week of 7 Dec stays exactly the vision.md week, so its roster still matches.
#
# It only adds what is missing, so it can run on an empty local server or on the deployed site
# that already holds the one-week seed (`npm run seed`). Running it twice adds nothing new.
#
# LOCAL (default): the local server's test sign-in.
#   PORT=3000 npm start                    # terminal 1: a fresh server
#   bash quality/uat/load-uat-data.sh      # terminal 2
#
# DEPLOYED: real sign-in tokens copied from the browser (quality/system-test-cases.md B.1).
#   export MODE=deployed BASE='https://<SiteUrl>'
#   read -rs COORD_TOKEN && export COORD_TOKEN          # coord1 (required)
#   read -rs ASHA_TOKEN  && export ASHA_TOKEN           # asha.rao     (each doctor's own leave;
#   read -rs BEN_TOKEN   && export BEN_TOKEN            # ben.ochieng   a doctor with no token
#   read -rs CHEN_TOKEN  && export CHEN_TOKEN           # chen.li       has their leave skipped)
#   read -rs DANA_TOKEN  && export DANA_TOKEN           # dana.novak
#   bash quality/uat/load-uat-data.sh
set -u

MODE="${MODE:-local}"
BASE="${BASE:-http://127.0.0.1:3000}"
NOW='"now":"2026-11-20T00:00:00.000Z"'  # honoured locally only; the deployed site uses its clock
FIRST=2026-11-23
LAST=2027-01-10
WEEKS=(2026-11-23 2026-11-30 2026-12-07 2026-12-14 2026-12-21 2026-12-28 2027-01-04)
PUBLISHED_WEEKS=6                        # 23 Nov to 3 Jan published; the week of 4 Jan stays a draft
LAST_STATUS=""
LAST_BODY=""
PROBLEMS=0

token_for() {
  case "$1" in
    coord1) printf '%s' "${COORD_TOKEN:-}" ;;
    asha.rao) printf '%s' "${ASHA_TOKEN:-}" ;;
    ben.ochieng) printf '%s' "${BEN_TOKEN:-}" ;;
    chen.li) printf '%s' "${CHEN_TOKEN:-}" ;;
    dana.novak) printf '%s' "${DANA_TOKEN:-}" ;;
  esac
}

# call <user-id> <role> <method> <path> [json-body]
call() {
  local id="$1" role="$2" method="$3" path="$4" body="${5:-}" out
  local auth=()
  if [ "$MODE" = "deployed" ]; then
    auth=(-H "Authorization: Bearer $(token_for "$id")")
  else
    auth=(-H "X-User-Id: $id" -H "X-User-Role: $role")
  fi
  if [ -n "$body" ]; then
    out=$(curl -s -w '\n%{http_code}' -X "$method" "${auth[@]}" -H 'Content-Type: application/json' \
      --data "$body" "$BASE$path")
  else
    out=$(curl -s -w '\n%{http_code}' -X "$method" "${auth[@]}" "$BASE$path")
  fi
  LAST_STATUS="${out##*$'\n'}"
  LAST_BODY="${out%$'\n'*}"
}
coord() { call coord1 coordinator "$@"; }
as_doc() { local who="$1"; shift; call "$who" doctor "$@"; }
has_token() { [ "$MODE" != "deployed" ] || [ -n "$(token_for "$1")" ]; }

ok() { printf '  ok   %s\n' "$1"; }
fail() { PROBLEMS=$((PROBLEMS + 1)); printf '  FAIL %s\n' "$1"; }
# expect <status...> <what>: the last call must have one of the given statuses
expect() {
  local what="${*: -1}" s
  for s in "${@:1:$#-1}"; do
    if [ "$LAST_STATUS" = "$s" ]; then printf '  ok   %-4s %s\n' "$LAST_STATUS" "$what"; return 0; fi
  done
  fail "$LAST_STATUS $what (wanted ${*:1:$#-1}: ${LAST_BODY:0:200})"
  return 1
}

if [ "$MODE" = "deployed" ] && [ -z "${COORD_TOKEN:-}" ]; then
  echo "MODE=deployed needs COORD_TOKEN (and doctor tokens for their leave)."; exit 2
fi
coord GET /api/me
if [ "$LAST_STATUS" != "200" ]; then
  echo "Cannot reach $BASE as the coordinator (got $LAST_STATUS). Local: run 'PORT=3000 npm start'."; exit 2
fi

echo "== Doctors =="
for d in \
  '{"id":"asha.rao","name":"Dr Asha Rao","grade":"consultant","modalities":["CT","MRI"],"maxHoursPerWeek":40}' \
  '{"id":"ben.ochieng","name":"Dr Ben Ochieng","grade":"resident","modalities":["CT","XR"],"maxHoursPerWeek":40}' \
  '{"id":"chen.li","name":"Dr Chen Li","grade":"resident","modalities":["US","XR"],"maxHoursPerWeek":40}' \
  '{"id":"dana.novak","name":"Dr Dana Novak","grade":"consultant","modalities":["MRI","US"],"maxHoursPerWeek":40}'; do
  coord POST /api/doctors "$d"
  expect 201 409 "$(printf '%s' "$d" | jq -r .name) (409: already there)"
done

echo "== Duties =="
coord GET "/api/duties?from=$FIRST&to=$LAST&includeCancelled=true"
EXISTING=$(printf '%s' "$LAST_BODY" | jq -c '[.[] | "\(.date) \(.type) \(.modality)"]')
ADDED=0
KEPT=0
duty() { # duty <date> <type> <modality> <needed> <consultant>; skips one that already exists
  if printf '%s' "$EXISTING" | jq -e --arg k "$1 $2 $3" 'index($k) != null' >/dev/null; then
    KEPT=$((KEPT + 1)); return
  fi
  coord POST /api/duties "{\"date\":\"$1\",\"type\":\"$2\",\"modality\":\"$3\",\"doctorsNeeded\":$4,\"needsConsultant\":$5}"
  if [ "$LAST_STATUS" = "201" ]; then ADDED=$((ADDED + 1)); else fail "duty $1 $2 $3: $LAST_STATUS ${LAST_BODY:0:200}"; fi
}
week_pattern() { # the 15-duty week, Mon to Sat
  local mon="$1"
  d() { date -d "$mon + $1 day" +%F; }
  duty "$(d 0)" AM CT 2 true;  duty "$(d 0)" PM MRI 1 true;  duty "$(d 0)" CALL XR 1 false
  duty "$(d 1)" AM US 1 false; duty "$(d 1)" AM XR 1 false; duty "$(d 1)" PM CT 1 false
  duty "$(d 2)" AM MRI 1 true; duty "$(d 2)" PM US 1 false; duty "$(d 2)" CALL CT 1 false
  duty "$(d 3)" AM XR 1 false; duty "$(d 3)" PM XR 1 false
  duty "$(d 4)" AM CT 1 false; duty "$(d 4)" PM US 1 false; duty "$(d 4)" CALL MRI 1 true
  duty "$(d 5)" CALL XR 1 false
}
week_pattern 2026-11-23
week_pattern 2026-11-30
# The week of 7 Dec: the vision.md example week, unchanged (the deployed seed already has it).
duty 2026-12-07 AM CT 2 true;  duty 2026-12-07 CALL XR 1 false
duty 2026-12-08 AM MRI 1 true; duty 2026-12-08 AM US 1 false; duty 2026-12-08 AM XR 1 false
duty 2026-12-09 PM XR 1 false
for mon in 2026-12-14 2026-12-21 2026-12-28 2027-01-04; do week_pattern "$mon"; done
coord GET "/api/duties?from=$FIRST&to=$LAST"
ok "$ADDED duties added, $KEPT already there: $(printf '%s' "$LAST_BODY" | jq length) duties over seven weeks"

echo "== Rules =="
coord GET /api/rules
RULE_TYPES=$(printf '%s' "$LAST_BODY" | jq -c '[.[].type]')
rule() { # rule <type> <body> <what>: added unless a rule of that type exists
  if printf '%s' "$RULE_TYPES" | jq -e --arg t "$1" 'index($t) != null' >/dev/null; then
    ok "     $3 (already there)"; return
  fi
  coord POST /api/rules "$2"; expect 201 "$3"
}
rule rest_after_call '{"type":"rest_after_call","strength":"hard","settings":{}}' "rest after call (hard)"
rule modality_assignment '{"type":"modality_assignment","strength":"soft","settings":{"who":{"grade":"resident"},"modalities":["XR"],"mode":"preferOn"}}' "prefer residents on XR (soft)"
rule duty_limit '{"type":"duty_limit","strength":"hard","settings":{"dutyType":"CALL","max":1,"per":"week"}}' "at most 1 CALL per doctor per week (hard)"
rule weekly_hours '{"type":"weekly_hours","strength":"soft","settings":{}}' "stay within weekly hours (soft)"
rule fair_share '{"type":"fair_share","strength":"soft","settings":{"dutyType":"CALL"}}' "spread CALL duties evenly (soft)"

echo "== Leave =="
coord GET /api/leave
LEAVE_NOW="$LAST_BODY"
LEAVE_ID=""
# leave <doctor> <start> <end> <reason> <decision: approve|reject|cancel|pending> <what>
leave() {
  local who="$1" start="$2" end="$3" reason="$4" decision="$5" what="$6" found status
  found=$(printf '%s' "$LEAVE_NOW" | jq -r --arg w "$who" --arg s "$start" --arg e "$end" \
    '[.[] | select(.doctorId == $w and .startDate == $s and .endDate == $e)][0] // empty | "\(.id) \(.status)"')
  if [ -n "$found" ]; then
    LEAVE_ID="${found%% *}"; status="${found##* }"
    ok "     $what (already there: $status)"
    [ "$status" = "pending" ] || return 0
  elif ! has_token "$who"; then
    ok "     $what (skipped: no token for $who)"; return 0
  else
    as_doc "$who" POST /api/leave "{\"startDate\":\"$start\",\"endDate\":\"$end\",\"reason\":\"$reason\"}"
    expect 201 "$what" || return 0
    LEAVE_ID=$(printf '%s' "$LAST_BODY" | jq -r .id)
  fi
  case "$decision" in
    approve) coord POST "/api/leave/$LEAVE_ID/approve"; expect 200 "  approved" ;;
    reject) coord POST "/api/leave/$LEAVE_ID/reject"; expect 200 "  rejected (does not block)" ;;
    cancel) as_doc "$who" POST "/api/leave/$LEAVE_ID/cancel"; expect 200 "  cancelled by $who (does not block)" ;;
    pending) ok "     left pending (does not block)" ;;
  esac
}
leave asha.rao 2026-11-26 2026-11-27 "audit day" approve "Rao 26-27 Nov"
leave chen.li 2026-11-30 2026-12-01 "course" reject "Chen 30 Nov-1 Dec"
leave dana.novak 2026-12-03 2026-12-03 "appointment" approve "Novak 3 Dec"
leave chen.li 2026-12-07 2026-12-09 "conference" approve "Chen 7-9 Dec (the vision.md leave)"
leave chen.li 2026-12-15 2026-12-15 "course" reject "Chen 15 Dec"
leave asha.rao 2026-12-17 2026-12-18 "exam board" approve "Rao 17-18 Dec"
leave ben.ochieng 2026-12-22 2026-12-22 "dentist" cancel "Ben 22 Dec"
leave chen.li 2026-12-24 2026-12-26 "Christmas" approve "Chen 24-26 Dec"
leave dana.novak 2026-12-27 2026-12-29 "travel" approve "Novak 27-29 Dec (across a week boundary)"
leave ben.ochieng 2026-12-28 2026-12-29 "family" pending "Ben 28-29 Dec"
leave chen.li 2026-12-30 2026-12-30 "appointment" pending "Chen 30 Dec"
leave ben.ochieng 2027-01-05 2027-01-06 "holiday" approve "Ben 5-6 Jan (in the draft week)"
leave chen.li 2027-01-08 2027-01-08 "training" pending "Chen 8 Jan"

echo "== Roster: generate seven weeks, publish the first six =="
coord POST /api/roster/generate "{\"weekStart\":\"$FIRST\",\"weeks\":7,$NOW}"; expect 200 "generate $FIRST + 7 weeks"
coord POST /api/roster/publish "{\"weekStart\":\"$FIRST\",\"weeks\":$PUBLISHED_WEEKS,$NOW}"; expect 200 "publish 23 Nov to 3 Jan (the week of 4 Jan stays a draft)"

echo "== Late leave: approved after publishing =="
mine_week() { # mine_week <doctor> <monday>
  as_doc "$1" GET "/api/roster/mine?from=$2&to=$(date -d "$2 + 6 day" +%F)"
  printf '%s' "$LAST_BODY" | jq -r '[.[] | "\(.duty.date[5:]) \(.duty.type) \(.duty.modality)"] | join(", ")'
}
if has_token ben.ochieng; then
  echo "  Ben's published week of 14 Dec before: $(mine_week ben.ochieng 2026-12-14)"
  leave ben.ochieng 2026-12-17 2026-12-17 "sick" approve "Ben 17 Dec, after publishing"
  AFTER=$(mine_week ben.ochieng 2026-12-14)
  echo "  Ben's published week of 14 Dec after:  $AFTER"
  case "$AFTER" in *12-17*) fail "Ben is still rostered on 12-17" ;; *) ok "     Ben is off 12-17 without anyone regenerating by hand" ;; esac
else
  ok "     late leave skipped: no token for ben.ochieng"
fi

echo "== Overlap cases the system must handle =="
if has_token chen.li; then
  as_doc chen.li POST /api/leave '{"startDate":"2026-12-25","endDate":"2026-12-27"}'
  expect 409 "Chen: leave overlapping her approved Christmas leave is refused"
  as_doc chen.li POST /api/leave '{"startDate":"2026-12-29","endDate":"2026-12-30"}'
  expect 409 "Chen: leave overlapping her own pending 30 Dec request is refused"
fi
coord GET /api/leave
APPROVED=$(printf '%s' "$LAST_BODY" | jq -c '[.[] | select(.status == "approved") | {doctorId, startDate, endDate}]')
same_time=0; daytime=0; calls=0; on_leave=0
for wk in "${WEEKS[@]}"; do
  version=published; [ "$wk" = "2027-01-04" ] && version=draft
  coord GET "/api/roster/weeks/$wk?version=$version"
  W="$LAST_BODY"
  same_time=$((same_time + $(printf '%s' "$W" | jq '[.placements[] as $p | .duties[] | select(.id == $p.dutyId) | {doc: $p.doctorId, slot: "\(.date) \(.type)"}] | group_by(.doc + .slot) | map(select(length > 1)) | length')))
  daytime=$((daytime + $(printf '%s' "$W" | jq '[.placements[] as $p | .duties[] | select(.id == $p.dutyId and .type != "CALL") | {doc: $p.doctorId, date}] | group_by(.doc + .date) | map(select(length > 1)) | length')))
  calls=$((calls + $(printf '%s' "$W" | jq '[.placements[] as $p | .duties[] | select(.id == $p.dutyId and .type == "CALL") | $p.doctorId] | group_by(.) | map(select(length > 1)) | length')))
  on_leave=$((on_leave + $(printf '%s' "$W" | jq --argjson leave "$APPROVED" '[.placements[] as $p | .duties[] | select(.id == $p.dutyId) | {doc: $p.doctorId, date} | select(. as $x | any($leave[]; .doctorId == $x.doc and .startDate <= $x.date and $x.date <= .endDate))] | length')))
done
[ "$same_time" -eq 0 ] && ok "     nobody holds two duties at the same time (all 7 weeks)" || fail "$same_time doctor-slots with two duties at once"
[ "$daytime" -eq 0 ] && ok "     nobody has an AM and a PM duty on the same day (all 7 weeks)" || fail "$daytime days with two daytime duties"
[ "$calls" -eq 0 ] && ok "     nobody has more than one CALL in a week (all 7 weeks)" || fail "$calls weeks with two CALLs for one doctor"
[ "$on_leave" -eq 0 ] && ok "     nobody is placed on a day of their approved leave (all 7 weeks)" || fail "$on_leave placements on approved leave"

coord GET /api/roster/weeks/2026-12-07
WEEK1="$LAST_BODY"
coord GET "/api/duties?from=2026-12-08&to=2026-12-08"
XR8=$(printf '%s' "$LAST_BODY" | jq -r '.[] | select(.type == "AM" and .modality == "XR") | .id')
gap_ok=$(printf '%s' "$WEEK1" | jq --arg xr "$XR8" '(.gaps | length) == 1 and .gaps[0].dutyId == $xr')
[ "$gap_ok" = "true" ] && ok "     the week of 7 Dec still has its one vision.md gap (8 Dec AM XR)" || fail "the week of 7 Dec no longer matches vision.md"

echo
echo "================ What each doctor sees, week by week ================"
for doc in asha.rao ben.ochieng chen.li dana.novak; do
  echo
  echo "## $doc"
  if ! has_token "$doc"; then echo "  (no token: shown from the coordinator's view of the weeks)"; fi
  total=0
  for wk in "${WEEKS[@]:0:$PUBLISHED_WEEKS}"; do
    coord GET "/api/roster/weeks/$wk"
    line=$(printf '%s' "$LAST_BODY" | jq -r --arg me "$doc" \
      '[.placements[] | select(.doctorId == $me) | .dutyId] as $ids | [.duties[] | select(.id as $i | $ids | index($i))] | sort_by(.date) | map("\(.date[5:]) \(.type) \(.modality)") | join(", ")')
    n=$(printf '%s' "$LAST_BODY" | jq --arg me "$doc" '[.placements[] | select(.doctorId == $me)] | length')
    total=$((total + n))
    printf '  week of Mon %s: %s\n' "$wk" "${line:-none}"
  done
  echo "  published duties, 23 Nov to 3 Jan: $total"
  coord GET /api/leave
  printf '%s' "$LAST_BODY" | jq -r --arg me "$doc" '
    map(select(.doctorId == $me)) | sort_by(.startDate)
    | if length == 0 then "  leave: none" else .[] | "  leave: \(.startDate)..\(.endDate) \(.status) (\(.reason // "-"))" end'
done

echo
echo "================ Coverage per week (coordinator) ================"
for wk in "${WEEKS[@]:0:$PUBLISHED_WEEKS}"; do
  coord GET "/api/roster/weeks/$wk/coverage"
  printf '%s' "$LAST_BODY" | jq -r --arg wk "$wk" '
    "  \($wk) published: \(.unfilled | length) unfilled, \(.brokenSoftRules | length) broken soft rules, \(.lockedClashes | length) clashes; hours " +
    (.hours | map("\(.doctorId) \(.hours)/\(.max // "-")") | join(", "))'
done
coord GET "/api/roster/weeks/2027-01-04?version=draft"
printf '%s' "$LAST_BODY" | jq -r '"  2027-01-04 draft only: \(.placements | length) places filled, \(.gaps | length) gaps (doctors see \"not published yet\")"'

echo
if [ "$PROBLEMS" -eq 0 ]; then echo "Loaded with no problems."; else echo "Loaded with $PROBLEMS problem(s): see FAIL lines."; fi
[ "$PROBLEMS" -eq 0 ]
