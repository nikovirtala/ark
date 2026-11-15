#!/usr/bin/env bash
# Audit: which tests could read the history or the state of the enclosing repository (ark itself)
# instead of a temporary repository. Read-only, prints a report to stdout.
# A test result can only be reused for an equal tree if no test depends on history above the tree.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
t='packages/*/src'
echo "# test files: $(git ls-files 'packages/*/src/**/*.test.ts' 'packages/*/src/*.test.ts' | wc -l)"
echo
echo "## 1. Tests that run a git history command (log, rev-list, describe, tag, rev-parse, show, merge-base)"
grep -rnE "rev-list|\"git\", \[\"(log|describe|tag|rev-parse|show|merge-base|shortlog|blame)\"" $t --include='*.test.ts' || true
echo
echo "## 2. Tests that use the working directory or the directory of the test file as a repository"
grep -rnE "process\.cwd\(\)|import\.meta\.dirname|__dirname" $t --include='*.test.ts' || true
echo
echo "## 3. Child processes started in the test without a cwd (they inherit the package directory, inside ark's own repository)"
for f in $(grep -rlE "(spawn|spawnSync|execFile|execFileSync|execSync)\(" $t --include='*.test.ts'); do
  awk -v F="$f" '/(spawn|spawnSync|execFile|execFileSync|execSync)\(/{c=NR; seen=0; line=$0}
    {if (c && NR<=c+6 && /cwd/) seen=1}
    NR==c+6 && c && !seen {print F ":" c ": " line; c=0}' "$f"
done
echo
echo "## 4. Tests that read files above the package (listed for check-commit.sh in scripts/test-inputs.txt)"
grep -vE '^#|^$' scripts/test-inputs.txt
