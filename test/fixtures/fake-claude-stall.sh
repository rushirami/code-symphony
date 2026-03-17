#!/bin/sh
# Mimics Claude CLI that starts but then stalls (hangs forever)
# Traps SIGTERM so the process can be cleanly killed in tests
trap 'exit 143' TERM INT
echo '{"type":"system","subtype":"init","session_id":"test-session-stall","tools":[]}'
# Hang indefinitely (using a loop since sleep may not be interruptible)
while true; do sleep 1 & wait; done
