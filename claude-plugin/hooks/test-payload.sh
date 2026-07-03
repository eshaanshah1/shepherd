#!/usr/bin/env bash
# Unit-tests the AskUserQuestion payload extraction filter used by report.sh.
set -eu
dir="$(cd "$(dirname "$0")" && pwd)"

fixture='{"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Pick one","header":"H","options":[{"label":"A"},{"label":"B"}],"multiSelect":false},{"question":"Pick many","header":"M","options":[{"label":"X"},{"label":"Y"},{"label":"Z"}],"multiSelect":true}]}}'
out="$(printf '%s' "$fixture" | jq -cf "$dir/askquestion-payload.jq")"
expected='[{"prompt":"Pick one","header":"H","options":["A","B"],"multiSelect":false},{"prompt":"Pick many","header":"M","options":["X","Y","Z"],"multiSelect":true}]'
[ "$out" = "$expected" ] || { printf 'FAIL askUserQuestion:\n got: %s\n exp: %s\n' "$out" "$expected"; exit 1; }

# A missing header defaults to "" and multiSelect defaults to false.
fixture2='{"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Q","options":[{"label":"A"}]}]}}'
out2="$(printf '%s' "$fixture2" | jq -cf "$dir/askquestion-payload.jq")"
expected2='[{"prompt":"Q","header":"","options":["A"],"multiSelect":false}]'
[ "$out2" = "$expected2" ] || { printf 'FAIL defaults:\n got: %s\n exp: %s\n' "$out2" "$expected2"; exit 1; }

echo PASS
