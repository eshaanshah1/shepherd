#!/usr/bin/env bash
# Shepherd × Claude Code integration.
#
# On each Claude Code lifecycle event, report {tab_id, event, detail} to the
# Shepherd app's unix socket so the tab's sidebar tracks the agent's state.
# `detail` carries the field Shepherd needs for that event (tool_name /
# notification_type / error_type / agent_type).
#
# Safe to install globally: if not running inside a Shepherd tab (env not
# injected, or Shepherd not running) this is a silent no-op. Never blocks or
# fails Claude — always exits 0.
#
# Usage from hooks.json:  report.sh <EventName>
set -u

event="${1:-unknown}"
payload="$(cat 2>/dev/null || true)"   # the hook's JSON payload on stdin

# Only act inside a live Shepherd tab.
[ -n "${SHEPHERD_TAB_ID:-}" ] && [ -n "${SHEPHERD_SOCK:-}" ] && [ -S "${SHEPHERD_SOCK}" ] || exit 0

# Pull one field out of the JSON payload (best-effort; empty on any failure).
field() {
  printf '%s' "$payload" | python3 -c 'import sys, json
try:
    print(str(json.load(sys.stdin).get(sys.argv[1], "")))
except Exception:
    pass' "$1" 2>/dev/null
}

detail=""
case "$event" in
  PreToolUse|PermissionRequest)  detail="$(field tool_name)" ;;
  Notification)                  detail="$(field notification_type)" ;;
  StopFailure)                   detail="$(field error_type)" ;;
  SubagentStart|SubagentStop)    detail="$(field agent_type)" ;;
esac

# JSON-escape backslashes and double quotes.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

printf '{"tab_id":"%s","event":"%s","detail":"%s"}\n' \
  "$(esc "$SHEPHERD_TAB_ID")" "$(esc "$event")" "$(esc "$detail")" \
  | nc -U "$SHEPHERD_SOCK" 2>/dev/null || true
exit 0
