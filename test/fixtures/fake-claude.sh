#!/bin/sh
# Mimics Claude CLI NDJSON output for a successful run
echo '{"type":"system","subtype":"init","session_id":"test-session-123","tools":[]}'
sleep 0.05
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Working on it..."}],"stop_reason":null},"session_id":"test-session-123"}'
sleep 0.05
echo '{"type":"result","subtype":"success","is_error":false,"result":"Done","session_id":"test-session-123","num_turns":2,"total_cost_usd":0.01,"duration_ms":500,"stop_reason":"end_turn"}'
