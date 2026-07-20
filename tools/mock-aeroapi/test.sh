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
echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "ALL TESTS PASSED" || { echo "SOME TESTS FAILED"; exit 1; }
