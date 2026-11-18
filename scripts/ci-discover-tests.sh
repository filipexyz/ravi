#!/usr/bin/env bash
# DISCOVERY ONLY (removed before merge): run each listed test file in its own
# process, report pass/fail and wall time per file, never stop at the first failure.
# usage: ci-discover-tests.sh <slice> <slices>   (takes every <slices>-th line of scripts/ci-orphans.txt)
set -u
slice="$1"; slices="$2"
fail=0; total=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  total=$((total + 1))
  start=$(date +%s%3N)
  out=$(timeout 300 bun test --timeout 20000 "./$f" 2>&1); rc=$?
  end=$(date +%s%3N)
  summary=$(printf '%s\n' "$out" | grep -E '^ *[0-9]+ (pass|fail)$' | tr -s ' ' | tr '\n' ' ')
  echo "DISCOVERY file=$f rc=$rc ms=$((end - start)) ${summary}"
  if [ "$rc" -ne 0 ]; then
    fail=$((fail + 1))
    echo "----- DISCOVERY-FAILURE-OUTPUT $f (rc=$rc) -----"
    printf '%s\n' "$out" | tail -60
    echo "----- END $f -----"
  fi
done < <(awk -v s="$slice" -v n="$slices" '(NR - 1) % n == s' scripts/ci-orphans.txt)
echo "DISCOVERY-SUMMARY slice=$slice files=$total failures=$fail"
[ "$fail" -eq 0 ]
