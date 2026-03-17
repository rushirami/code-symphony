#!/bin/sh
# Mimics Claude CLI that returns an error result (exit 0 but is_error: true)
echo '{"type":"system","subtype":"init","session_id":"test-session-rerr","tools":[]}'
sleep 0.05
echo '{"type":"result","subtype":"error","is_error":true,"result":"Out of tokens","session_id":"test-session-rerr","num_turns":1,"total_cost_usd":0.05,"duration_ms":1000,"stop_reason":"error"}'
