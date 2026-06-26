#!/usr/bin/env bash
# Shepherd spike hook — forward one Claude Code lifecycle event to the Shepherd socket.
#
#   usage (from hooks.json):  report.sh <EventName>
#
# Correlation: $SHEPHERD_TAB_ID is injected into the pane's PTY env by the app, so
# it is inherited by `claude` and by this hook subprocess. No PID guessing.
set -u

event="${1:-unknown}"
tab="${SHEPHERD_TAB_ID:-unknown}"
sock="${SHEPHERD_SOCK:-/tmp/shepherd.sock}"

# Drain the hook's stdin JSON payload so Claude never blocks writing to us.
cat >/dev/null 2>&1 || true

# Fire-and-forget. Never fail the hook (always exit 0), even if nothing is listening.
printf '{"tab_id":"%s","event":"%s"}\n' "$tab" "$event" | nc -U "$sock" 2>/dev/null || true
exit 0
