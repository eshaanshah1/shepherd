#!/usr/bin/env bash
# Shepherd × Claude Code integration.
#
# Reports {tab_id, event, detail} to the Shepherd app's unix socket so the tab's
# sidebar tracks the agent's state. The state is decided by the EVENT NAME alone
# (passed as $1) + tab_id (from env), so the common path does ZERO JSON parsing
# and spawns nothing — it stays fast and in-order. Only the 3 events that show a
# cosmetic "reason" parse one field, via jq (~5ms; grep fallback).
#
# Safe to install globally: silent no-op outside a live Shepherd tab. Never blocks
# or fails Claude — always exits 0.
#
# Usage from hooks.json:  report.sh <EventName>
set -u

event="${1:-unknown}"

# Drain the hook's stdin payload so Claude never blocks writing to us.
payload="$(cat 2>/dev/null || true)"

# Only act inside a live Shepherd tab.
[ -n "${SHEPHERD_TAB_ID:-}" ] && [ -n "${SHEPHERD_SOCK:-}" ] && [ -S "${SHEPHERD_SOCK}" ] || exit 0

# Cosmetic "reason" field — only the few events that have one parse anything.
detail=""
key=""
case "$event" in
  PermissionRequest)          key="tool_name" ;;
  StopFailure)                key="error_type" ;;
  SubagentStart|SubagentStop) key="agent_type" ;;
esac
if [ -n "$key" ] && [ -n "$payload" ]; then
  if command -v jq >/dev/null 2>&1; then
    detail="$(printf '%s' "$payload" | jq -r --arg k "$key" '.[$k] // ""' 2>/dev/null)"
  else
    detail="$(printf '%s' "$payload" | grep -oE "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"
  fi
fi

esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
printf '{"tab_id":"%s","event":"%s","detail":"%s"}\n' \
  "$(esc "$SHEPHERD_TAB_ID")" "$(esc "$event")" "$(esc "$detail")" \
  | nc -U "$SHEPHERD_SOCK" 2>/dev/null || true
exit 0
