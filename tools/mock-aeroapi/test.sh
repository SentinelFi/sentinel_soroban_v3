#!/usr/bin/env bash
# Automated test for mock AeroAPI server
set -euo pipefail

PORT=3099
BASE="http://localhost:$PORT"
PASS=0
FAIL=0

# Kill any leftover server on this port
if command -v lsof &>/dev/null; then
    # macOS / Linux with lsof
    lsof -ti:$PORT | xargs kill 2>/dev/null || true
elif command -v fuser &>/dev/null; then
    # Linux without lsof
    fuser -k ${PORT}/tcp 2>/dev/null || true
else
    # Windows (Git Bash / MSYS2)
    powershell -Command "Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id \$_ -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
fi
sleep 1

# Start server in background
PORT=$PORT npx tsx src/server.ts &
SERVER_PID=$!
sleep 2

cleanup() { kill $SERVER_PID 2>/dev/null || true; }
trap cleanup EXIT

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $label = $expected"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

extract() {
  python3 -c "
import sys, json
data = json.load(sys.stdin)
flights = data.get('flights', [])
if not flights:
    print('EMPTY')
else:
    f = flights[0]
    field = sys.argv[1]
    val = f
    for key in field.split('.'):
        val = val[key] if isinstance(val, dict) else val
    print(val)
" "$1"
}

echo "=== Test: on_time flight (AA100) ==="
RESP=$(curl -s "$BASE/flights/AA100?start=2026-03-20T00:00:00Z")
assert_eq "cancelled"     "False"   "$(echo "$RESP" | extract cancelled)"
assert_eq "arrival_delay" "-300"    "$(echo "$RESP" | extract arrival_delay)"
assert_eq "scheduled_in"  "2026-03-20T11:00:00Z" "$(echo "$RESP" | extract scheduled_in)"
ACTUAL_IN=$(echo "$RESP" | extract actual_in)
assert_eq "actual_in set" "true" "$([ "$ACTUAL_IN" != "None" ] && echo true || echo false)"

echo ""
echo "=== Test: delayed flight (UAL456, 180min) ==="
RESP=$(curl -s "$BASE/flights/UAL456?start=2026-03-20T00:00:00Z")
assert_eq "cancelled"     "False"   "$(echo "$RESP" | extract cancelled)"
assert_eq "arrival_delay" "10800"   "$(echo "$RESP" | extract arrival_delay)"
ACTUAL_IN=$(echo "$RESP" | extract actual_in)
assert_eq "actual_in set" "true" "$([ "$ACTUAL_IN" != "None" ] && echo true || echo false)"

echo ""
echo "=== Test: cancelled flight (DL789) ==="
RESP=$(curl -s "$BASE/flights/DL789?start=2026-03-20T00:00:00Z")
assert_eq "status"    "Cancelled" "$(echo "$RESP" | extract status)"
assert_eq "cancelled" "True"      "$(echo "$RESP" | extract cancelled)"
assert_eq "actual_in" "None"      "$(echo "$RESP" | extract actual_in)"

echo ""
echo "=== Test: en_route flight (SW333) ==="
RESP=$(curl -s "$BASE/flights/SW333?start=2026-03-20T00:00:00Z")
assert_eq "status"    "En Route" "$(echo "$RESP" | extract status)"
assert_eq "cancelled" "False"    "$(echo "$RESP" | extract cancelled)"
assert_eq "actual_in" "None"     "$(echo "$RESP" | extract actual_in)"

echo ""
echo "=== Test: unknown flight (FAKE999) ==="
RESP=$(curl -s "$BASE/flights/FAKE999")
FLIGHT_COUNT=$(echo "$RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['flights']))")
assert_eq "flights array empty" "0" "$FLIGHT_COUNT"

echo ""
echo "=== Test: diverted flight (DIV555) ==="
RESP=$(curl -s "$BASE/flights/DIV555?start=2026-03-20T00:00:00Z")
assert_eq "diverted"  "True"     "$(echo "$RESP" | extract diverted)"
assert_eq "cancelled" "False"    "$(echo "$RESP" | extract cancelled)"
assert_eq "status"    "Diverted" "$(echo "$RESP" | extract status)"
ACTUAL_IN=$(echo "$RESP" | extract actual_in)
assert_eq "actual_in set (the trap)" "true" "$([ "$ACTUAL_IN" != "None" ] && echo true || echo false)"

echo ""
echo "=== Test: tracking lost (LOST666 — cancelled flag, non-cancelled status) ==="
RESP=$(curl -s "$BASE/flights/LOST666?start=2026-03-20T00:00:00Z")
assert_eq "cancelled" "True"           "$(echo "$RESP" | extract cancelled)"
assert_eq "status"    "result unknown" "$(echo "$RESP" | extract status)"

echo ""
echo "=== Test: scripted error (ERR500) ==="
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/flights/ERR500?start=2026-03-20T00:00:00Z")
assert_eq "HTTP status" "500" "$CODE"

echo ""
echo "=== Test: /schedules window (AA / 100, 3 days) ==="
RESP=$(curl -s "$BASE/schedules/2026-03-20/2026-03-23?airline=AA&flight_number=100")
ROWS=$(echo "$RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['scheduled']))")
assert_eq "one row per day" "3" "$ROWS"
FIRST_OUT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['scheduled'][0]['scheduled_out'])")
assert_eq "scheduled_out day 1" "2026-03-20T08:00:00Z" "$FIRST_OUT"

echo ""
echo "=== Test: call-counter stats ==="
STATS=$(curl -s "$BASE/__stats")
FLIGHTS_N=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin)['flights'])")
SCHED_N=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin)['schedules'])")
assert_eq "flights calls counted" "8" "$FLIGHTS_N"
assert_eq "schedules calls counted" "1" "$SCHED_N"
curl -s -X POST "$BASE/__reset" > /dev/null
FLIGHTS_N=$(echo "$(curl -s "$BASE/__stats")" | python3 -c "import sys,json; print(json.load(sys.stdin)['flights'])")
assert_eq "reset zeroes counters" "0" "$FLIGHTS_N"

echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "ALL TESTS PASSED" || { echo "SOME TESTS FAILED"; exit 1; }
