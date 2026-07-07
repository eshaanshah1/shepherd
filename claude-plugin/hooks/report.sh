#!/usr/bin/env bash
# Shepherd × Claude Code integration.
#
# Reports {tab_id, event, detail} to the Shepherd app's unix socket so the tab's
# sidebar tracks the agent's state. The state is decided by the EVENT NAME alone
# (passed as $1) + tab_id (from env), so the common path does ZERO JSON parsing
# and spawns nothing — it stays fast and in-order. Only a few events parse JSON
# (via jq, ~5ms): the cosmetic "reason" field for tool/agent/error names, and
# `Stop` reduces `background_tasks` to a count of work the turn is paused on so a
# backgrounded agent is never read as done.
#
# Safe to install globally: silent no-op outside a live Shepherd tab. Never blocks
# or fails Claude — always exits 0.
#
# Usage from hooks.json:  report.sh <EventName>
set -u

event="${1:-unknown}"

# Drain the hook's stdin payload so Claude never blocks writing to us.
payload_src="$(cat 2>/dev/null || true)"

# Only act inside a live Shepherd tab.
[ -n "${SHEPHERD_TAB_ID:-}" ] && [ -n "${SHEPHERD_SOCK:-}" ] && [ -S "${SHEPHERD_SOCK}" ] || exit 0

# Cosmetic "reason" field — only the few events that have one parse anything.
detail=""
key=""
case "$event" in
  PreToolUse|PermissionRequest) key="tool_name" ;;
  StopFailure)                  key="error_type" ;;
  SubagentStart|SubagentStop)   key="agent_type" ;;
  SessionStart)                 key="session_id" ;;   # carried so Shepherd can resume the agent on relaunch
esac
if [ -n "$key" ] && [ -n "$payload_src" ]; then
  if command -v jq >/dev/null 2>&1; then
    detail="$(printf '%s' "$payload_src" | jq -r --arg k "$key" '.[$k] // ""' 2>/dev/null)"
  else
    detail="$(printf '%s' "$payload_src" | grep -oE "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"
  fi
elif [ "$event" = "Stop" ] && [ -n "$payload_src" ] && command -v jq >/dev/null 2>&1; then
  # detail = how many background tasks the turn is paused on. A backgrounded
  # subagent/workflow/shell holds the "turn done" notification; a passive monitor
  # does not. Unparseable -> "" -> the app treats it as 0 (plain finish-on-Stop).
  detail="$(printf '%s' "$payload_src" \
    | jq -r '[.background_tasks[]? | select(.type=="subagent" or .type=="workflow" or .type=="shell")] | length' 2>/dev/null)"
fi

# Structured prompt payload — only AskUserQuestion carries one (its questions + options),
# so the phone can render tappable answers. detail stays the tool_name for the state machine.
payload=""
if [ "$event" = "PreToolUse" ] && [ "$detail" = "AskUserQuestion" ] && [ -n "$payload_src" ] && command -v jq >/dev/null 2>&1; then
  payload="$(printf '%s' "$payload_src" | jq -cf "$(dirname "$0")/askquestion-payload.jq" 2>/dev/null)"
fi

esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
if [ -n "$payload" ]; then
  printf '{"tab_id":"%s","event":"%s","detail":"%s","payload":"%s"}\n' \
    "$(esc "$SHEPHERD_TAB_ID")" "$(esc "$event")" "$(esc "$detail")" "$(esc "$payload")"
else
  printf '{"tab_id":"%s","event":"%s","detail":"%s"}\n' \
    "$(esc "$SHEPHERD_TAB_ID")" "$(esc "$event")" "$(esc "$detail")"
fi | nc -U "$SHEPHERD_SOCK" 2>/dev/null || true
exit 0
