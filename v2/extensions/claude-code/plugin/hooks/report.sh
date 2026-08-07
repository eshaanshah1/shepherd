#!/usr/bin/env bash
# Shepherd v2 × Claude Code.
#
# POSTs one event envelope to Shepherd's event ingress so the session's state
# indicator tracks the agent. Silent no-op outside a Shepherd v2 pane, and it
# never blocks or fails Claude — always exits 0.
#
# Usage from hooks.json:  report.sh <EventName>
#
# Three properties, each of which is a v1 bug this file exists not to repeat:
#
#   1. **It stays bash, and spawns nothing to build the envelope.** ADR 0004
#      measured python3's ~50ms of startup putting `PreToolUse` behind `Stop` and
#      flipping the pane's state; node's ~40ms would do the same. There is also
#      no `jq` here — v1 needed it to escape fields it EXTRACTED, and v2 extracts
#      nothing: the hook payload rides whole and TypeScript parses it. Splicing
#      an already-valid JSON document into JSON is concatenation, not parsing.
#      (`jq` is also Homebrew-only on macOS, while `curl` is /usr/bin.)
#   2. **Nothing here can stall the agent.** Hooks are synchronous, so a wedged
#      listener would hang the turn — the observer stalling the observed. Hence
#      `--max-time`, and `|| true` on everything.
#   3. **A payload that cannot be read is still reported.** State is decided by
#      the EVENT NAME, so a lost payload costs a cosmetic reason string and
#      nothing else; losing the event itself would strand the pane.
set -u

event="${1:-unknown}"

# Drain stdin first, unconditionally, so Claude never blocks writing to us even
# when we are about to no-op.
payload="$(cat 2>/dev/null || true)"

# Only act inside a live Shepherd v2 pane. These names are v2's own: v1 uses
# SHEPHERD_TAB_ID/SHEPHERD_SOCK and speaks a different protocol on them, so the
# two plugins coexist on one machine by not sharing a variable.
[ -n "${SHEPHERD_SESSION_ID:-}" ] && [ -n "${SHEPHERD_EVENTS_SOCK:-}" ] && [ -S "${SHEPHERD_EVENTS_SOCK}" ] || exit 0

# The payload is already a JSON document, so it is spliced verbatim. Anything
# that does not start with `{` is not one — `null` keeps the envelope valid and
# the event alive. One character of inspection, no parser.
case "$payload" in
  '{'*) hook="$payload" ;;
  *)    hook=null ;;
esac

# Written in three parts rather than one `printf`, so a large payload (an
# AskUserQuestion carries its whole question set) never becomes a single
# oversized argv. Only `$event` and the session id are interpolated: the first is
# a fixed name from hooks.json, the second a UUID the kernel minted, so neither
# can contain a quote and nothing needs escaping.
#
# There is deliberately no `seq`. A per-session counter file would be a
# read-increment-write with no lock, and two hooks racing it would both send the
# same number — which the bus drops as a duplicate, silently losing a Stop or a
# PermissionRequest. The bus numbers per source instead.
{
  printf '{"topic":"claude.hook","session_id":"%s","payload":{"event":"%s","hook":' \
    "$SHEPHERD_SESSION_ID" "$event"
  printf '%s' "$hook"
  printf '}}'
} | curl -sS --max-time 2 \
      --unix-socket "$SHEPHERD_EVENTS_SOCK" \
      -H 'content-type: application/json' \
      --data-binary @- \
      http://unix/events >/dev/null 2>&1 || true

exit 0
