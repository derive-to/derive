#!/usr/bin/env bash
# The whole Sources rail against a DEPLOYED Derive — connect, pin, claim, proxy, write.
#
# The in-process version of this lives in weather-artifact.manual.ts. This one runs the same
# sequence over the public internet against a real Worker, which is the only way to catch the
# class of bug that hides in the runtime rather than the logic: the broker's fetch was invoked
# with the wrong `this`, which Node accepts and workerd rejects, so every test passed while the
# deployed feature reached nothing.
#
# The model step is deliberately not here. What is under test is the rail — connect, pin, claim,
# proxy, write — so the executor's one job (turn a tool result into prose) is done by this script.
# Everything either side of it is the real deployed path.
#
#   BASE=https://derive-pr-575.derive-to.workers.dev \
#   EMAIL=… PASSWORD=… WEATHER=https://…/mcp \
#   bash apps/api/test/live-preview-weather.sh
set -euo pipefail

BASE="${BASE:?set BASE to the deployment under test}"
EMAIL="${EMAIL:?}"; PASSWORD="${PASSWORD:?}"
WEATHER="${WEATHER:?set WEATHER to a reachable MCP server URL}"
J=$(mktemp)
# Cleanup on ANY exit, including a failed step. This writes to a shared workspace backed by
# production data, so "the script died halfway" must not mean "the litter stays".
CONN_ID=""; SHORT=""; AGENT_ID=""; AUTO_ID=""
cleanup() {
  set +e
  local targets=""
  [ -n "$AUTO_ID" ] && targets="$targets automations/$AUTO_ID"
  [ -n "$CONN_ID" ] && targets="$targets connections/$CONN_ID"
  [ -n "$AGENT_ID" ] && targets="$targets agents/$AGENT_ID"
  # KEEP=1 leaves the document up so it can be looked at or screenshotted.
  [ -n "$SHORT" ] && [ -z "${KEEP:-}" ] && targets="$targets artifacts/$SHORT"
  for U in $targets; do
    printf '  cleanup %-26s %s\n' "$U" "$(curl -sS -b "$J" -X DELETE "$BASE/v1/$U" -o /dev/null -w '%{http_code}')"
  done
  rm -f "$J"
}
trap cleanup EXIT
# Read one field out of a JSON response: `jqr id`, `jqr user.email`.
jqr() {
  python3 -c '
import json, sys
d = json.load(sys.stdin)
for k in sys.argv[1].split("."):
    d = d.get(k) if isinstance(d, dict) else None
print(d if d is not None else "")' "$1"
}

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

step "1. sign in"
curl -sS -c "$J" -X POST "$BASE/api/auth/sign-in/email" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" -o /dev/null
curl -sS -b "$J" "$BASE/v1/me" | jqr user.email

step "2. connect the MCP server (the Worker contacts it and pins its tools)"
CONN=$(curl -sS -b "$J" -X POST "$BASE/v1/connections" -H 'content-type: application/json' \
  -d "{\"toolkit\":\"weather\",\"mcp_url\":\"$WEATHER\"}")
echo "$CONN" | python3 -m json.tool | head -14
CONN_ID=$(echo "$CONN" | jqr id)
test "$(echo "$CONN" | jqr status)" = active || { echo "NOT ACTIVE"; exit 1; }

step "3. create the document the automation will rewrite"
ART=$(curl -sS -b "$J" -X POST "$BASE/v1/artifacts" -H 'accept: application/json' \
  -F "file=@-;filename=index.html;type=text/html" -F "title=Weather watch (live preview)" \
  <<< '<h1>Weather watch</h1><p>No readings yet.</p>')
SHORT=$(echo "$ART" | jqr short_id); echo "artifact $SHORT"

step "4. an agent, and an automation bound to the source and the document"
# Unique per run: agent names are unique per workspace, so a leftover from an interrupted run
# makes the next one fail at create with an error this script would otherwise carry forward as an
# empty token — and an empty bearer reads as a flat "forbidden" from the tool proxy, which looks
# like the feature refusing rather than the fixture being wrong.
AGENT_NAME="weather-runner-$$"
AGENT=$(curl -sS -b "$J" -X POST "$BASE/v1/agents" -H 'content-type: application/json' \
  -d "{\"name\":\"$AGENT_NAME\"}")
AGENT_ID=$(echo "$AGENT" | jqr id); TOKEN=$(echo "$AGENT" | jqr token)
echo "agent $AGENT_ID, token ${#TOKEN} chars"
[ -n "$TOKEN" ] || { echo "AGENT CREATE SAID: $AGENT"; exit 1; }
AUTO=$(curl -sS -b "$J" -X POST "$BASE/v1/automations" -H 'content-type: application/json' \
  -d "{\"agentId\":\"$AGENT_ID\",\"instruction\":\"Rewrite the weather table from the connected weather source.\",\"trigger\":{\"kind\":\"manual\"},\"connectionIds\":[\"$CONN_ID\"],\"refs\":[{\"kind\":\"artifact\",\"id\":\"$SHORT\"}]}")
AUTO_ID=$(echo "$AUTO" | jqr id); echo "automation $AUTO_ID"

step "5. run now, and wait for it to actually be running"
# NOT claimed here. With hosted execution enabled the platform's own dispatcher claims this run
# (as this same agent) the moment it is due, and a claim is exclusive — a standing bearer polling
# `/v1/agent/runs/claim` always loses and comes back empty, which looks exactly like "the tools
# never reached the run". The tool endpoint accepts a standing bearer for a run this agent owns
# while it is RUNNING, which is what this uses. That leniency is a known gap the endpoint
# documents; here it is the only way to exercise the deployed proxy from outside.
RUN_ID=$(curl -sS -b "$J" -X POST "$BASE/v1/automations/$AUTO_ID/run" | jqr id)
TOOL="$(printf '%s' "${WEATHER#https://}" | tr -c 'a-zA-Z0-9' '_' | sed 's/_*$//' | sed 's/_mcp$//').get_current_weather"
for _ in $(seq 1 90); do
  ST=$(curl -sS -b "$J" "$BASE/v1/workspace/runs" | python3 -c "
import json,sys
r=[x for x in json.load(sys.stdin)['runs'] if x['id']=='$RUN_ID']
print(r[0]['status'] if r else '?')")
  [ "$ST" = running ] && break
  case "$ST" in succeeded|failed|refused) echo "run settled as $ST before the tool could be called"; break;; esac
  sleep 1
done
echo "run $RUN_ID is $ST; will call $TOOL"

step "6. read live weather THROUGH THE PROXY (the run never holds the URL or a credential)"
ROWS=""
for CITY in London Tokyo Reykjavik; do
  OUT=$(curl -sS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "$BASE/v1/agent/runs/$RUN_ID/tool" -d "{\"tool\":\"$TOOL\",\"args\":{\"city\":\"$CITY\"}}")
  echo "$OUT" | grep -q '"result"' || { echo "  $CITY -> $OUT"; continue; }
  echo "$OUT" | python3 -c "
import json,sys
w=json.load(sys.stdin)['result']['structuredContent']
print(f\"  {w['place']}: {w['temperature_c']}°C, wind {w['wind_kph']} km/h, {w['condition']} @ {w['observed_at']}\")"
  ROWS="$ROWS$(echo "$OUT" | python3 -c "
import json,sys
w=json.load(sys.stdin)['result']['structuredContent']
print(f\"<tr><td>{w['place']}</td><td>{w['temperature_c']} °C</td><td>{w['wind_kph']} km/h</td><td>{w['condition']}</td><td>{w['observed_at']}</td></tr>\")")
"
done

step "7. write the document (the executor's turn, done here)"
REPORT="<h1>Weather watch</h1>
<table>
<tr><th>Place</th><th>Temp</th><th>Wind</th><th>Conditions</th><th>Observed</th></tr>
$ROWS</table>
<p>Read from a connected MCP server through Derive's tool proxy, on $BASE. Every figure came off the wire during this run.</p>"
curl -sS -b "$J" -X POST "$BASE/v1/artifacts/$SHORT/versions" -H 'accept: application/json' \
  -F "file=@-;filename=index.html;type=text/html" -F "message=Weather from the connected source" \
  <<< "$REPORT" -o /dev/null

step "8. what the hosted run itself did"
# NOT settled from here — the hosted executor owns this claim. Whatever it reports is reported.
for _ in $(seq 1 40); do
  ST=$(curl -sS -b "$J" "$BASE/v1/workspace/runs" | python3 -c "
import json,sys
r=[x for x in json.load(sys.stdin)['runs'] if x['id']=='$RUN_ID']
print(r[0]['status'] if r else '?')")
  case "$ST" in succeeded|failed|refused) break;; esac
  sleep 5
done
curl -sS -b "$J" "$BASE/v1/workspace/runs" | python3 -c "
import json,sys
r=[x for x in json.load(sys.stdin)['runs'] if x['id']=='$RUN_ID']
print('  hosted run:', r[0]['status'], r[0].get('meta') if r else '')"

step "9. what the document says now"
curl -sS -b "$J" "$BASE/v1/artifacts/$SHORT/content"
echo
echo "ARTIFACT  $BASE/artifacts/$SHORT"
echo "RUN       $RUN_ID"
curl -sS -b "$J" "$BASE/v1/workspace/runs" | python3 -c "
import json,sys
r=[x for x in json.load(sys.stdin)['runs'] if x['id']=='$RUN_ID']
print('LEDGER   ', r[0]['status'] if r else 'not in feed')"

step "10. clean up (shared workspace, production data) — see the EXIT trap"
# KEEP=1 leaves the document up so it can be looked at or screenshotted.
