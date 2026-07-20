#!/bin/sh
# Fake agent that closes its task through the symphony CLI, like a real agent would.
# Requires env: SYMPHONY_DB (set by the runner via agent.env), SYMPHONY_REPO, SYMPHONY_TASK.
echo '{"type":"system","subtype":"init","session_id":"sess-done-1","tools":[]}'
cd "$SYMPHONY_REPO" && npx tsx src/cli/index.ts done "$SYMPHONY_TASK" \
  --note "Completed by fake agent" --author "agent:$SYMPHONY_TASK" 1>&2
echo '{"type":"result","subtype":"success","is_error":false,"result":"Done","session_id":"sess-done-1","num_turns":1,"total_cost_usd":0.01,"duration_ms":100,"stop_reason":"end_turn"}'
