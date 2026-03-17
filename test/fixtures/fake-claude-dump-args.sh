#!/bin/sh
# Writes args and cwd to files for test assertions, then emits NDJSON
echo "$@" > "$PWD/.claude-args"
echo "$PWD" > "$PWD/.claude-cwd"
echo '{"type":"system","subtype":"init","session_id":"test-session-dump","tools":[]}'
sleep 0.05
echo '{"type":"result","subtype":"success","is_error":false,"result":"Done","session_id":"test-session-dump","num_turns":1,"total_cost_usd":0.001,"duration_ms":100,"stop_reason":"end_turn"}'
