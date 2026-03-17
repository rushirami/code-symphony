#!/bin/sh
# Mimics Claude CLI that encounters an error
echo '{"type":"system","subtype":"init","session_id":"test-session-err","tools":[]}'
sleep 0.05
echo "Something went wrong" >&2
exit 1
