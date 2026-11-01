#!/usr/bin/env bash
# Verify the tree: the numbers in handoff/01-STATE.md, and the three gates.
#
# Usage:  handoff/tools/check.sh          numbers and gates
#         handoff/tools/check.sh --quick  numbers only
set -u

export PATH="$PATH:/c/Users/mushii/.cargo/bin"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || exit 1

echo "== numbers =="
tests=$(grep -rc "#\[test\]" crates/*/src crates/*/tests 2>/dev/null | awk -F: '{s+=$2} END {print s}')
echo "tests (declared)  $tests"
echo "specs             $(ls specs/*.md | wc -l)"
echo "open deferred     $(grep -c '^| D-' DEFERRED.md)"
echo "tags              $(git tag | wc -l)"
echo "rust lines        $(find crates -name '*.rs' -not -path '*/target/*' | xargs wc -l | tail -1 | awk '{print $1}')"
echo "ui lines          $(find ui/src -name '*.ts*' | xargs wc -l | tail -1 | awk '{print $1}')"
echo "head              $(git log --oneline -1)"

if [ "${1:-}" = "--quick" ]; then
    exit 0
fi

echo
echo "== gates =="
fail=0

cargo fmt --all --check >/dev/null 2>&1 && echo "fmt               ok" || { echo "fmt               FAILED"; fail=1; }

if cargo clippy --workspace --exclude bforge-gui --all-targets -- -D warnings >/tmp/bforge-clippy.log 2>&1; then
    echo "clippy            ok"
else
    echo "clippy            FAILED (see /tmp/bforge-clippy.log)"
    fail=1
fi

if out=$(cargo test --workspace --exclude bforge-gui 2>&1); then
    passed=$(echo "$out" | grep -oE "test result: ok\. [0-9]+ passed" | awk '{s+=$4} END {print s}')
    echo "tests             ok, $passed passed"
else
    echo "tests             FAILED"
    fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
    echo "the tree is green"
else
    echo "the tree is NOT green"
fi
exit "$fail"
