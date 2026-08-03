#!/usr/bin/env bash
# Drive the Android client through the flow that kept breaking, and assert it from the logs
# instead of asking a human what they saw.
#
# WHY THIS EXISTS: every phone-path bug this session was diagnosed by a person opening the app,
# reporting a symptom, and an agent inferring a cause. That loop cost a day and shipped three
# fixes that each introduced the next bug. The app now logs (SLog) and so does the host, so the
# whole sequence is machine-checkable: pair state, stream up, lock, unlock, reattach.
#
#   scripts/phone-smoke.sh <paneID> [--install]
#
# <paneID> is a host pane id (first 8 chars are enough for the log check, but pass the full id —
# it goes to the app as a deep link so no UI tapping is needed). Get one from:
#   shepherd ls
set -uo pipefail

PKG="com.eshaan.shepherd"
ACT="$PKG/.MainActivity"
HOST_LOG="/tmp/shepherd-events.log"
PANE="${1:-}"
[ -n "$PANE" ] || { echo "usage: $0 <paneID> [--install]"; exit 64; }
SHORT="${PANE:0:8}"

step()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()    { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

adb devices | grep -qw device || { echo "no adb device"; exit 1; }

if [ "${2:-}" = "--install" ]; then
  step "building + installing the APK"
  ( cd "$(dirname "$0")/../android" \
    && JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17} \
       ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk} \
       ./gradlew :app:assembleDebug -q --console=plain ) || exit 1
  adb install -r "$(dirname "$0")/../android/app/build/outputs/apk/debug/app-debug.apk" | tail -1
fi

# Wait for a logcat line matching $1 within $2 seconds. Prints the line it matched.
wait_for() {
  local pattern="$1" secs="$2" line
  for _ in $(seq 1 "$secs"); do
    line=$(adb logcat -d -s Shepherd:V 2>/dev/null | grep -E "$pattern" | tail -1)
    [ -n "$line" ] && { echo "       ${line##*Shepherd}"; return 0; }
    sleep 1
  done
  return 1
}

step "launching straight into pane $SHORT (deep link — no UI tapping)"
adb logcat -c
adb shell am start -n "$ACT" --es paneID "$PANE" >/dev/null

step "1. control channel accepted"
wait_for "conn  accepted by" 20 && ok "paired + nonce issued" || bad "no control session"

step "2. stream up"
if wait_for "data  READY pane $SHORT" 20; then
  ok "data channel READY"
else
  # The host says WHY it refused; that is the whole point of its logging.
  bad "no stream. Host's last word on it:"
  grep " pty " "$HOST_LOG" 2>/dev/null | tail -3 | sed 's/^/       /'
fi

step "3. lock the phone (screen off)"
adb shell input keyevent 26
sleep 6
ok "locked for 6s"

step "4. unlock and require an immediate reattach"
adb shell input keyevent 26; sleep 1; adb shell input keyevent 82   # wake + dismiss keyguard
adb logcat -c                                                       # only count NEW lines
before=$(date +%s)
if wait_for "data  READY pane $SHORT|vm  resume" 12; then
  ok "reattached in $(( $(date +%s) - before ))s"
else
  bad "no reattach after unlock — the exact regression this script exists for"
fi

step "5. no reconnect storm"
n=$(adb logcat -d -s Shepherd:V 2>/dev/null | grep -c "data  dialling")
if [ "$n" -le 4 ]; then ok "$n dial(s) since unlock"; else bad "$n dials — storming"; fi

step "6. host agrees"
grep -E " pty | lan " "$HOST_LOG" 2>/dev/null | tail -4 | sed 's/^/       /'

printf '\n'
[ "$FAILED" = 0 ] && { echo "SMOKE PASSED"; exit 0; } || { echo "SMOKE FAILED"; exit 1; }
