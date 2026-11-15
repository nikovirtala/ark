#!/usr/bin/env bash
# Dynamic check for the result cache: run every package's tests with a `git` shim first on PATH
# that logs each call whose working directory, or an argument, is inside this repository. A test
# that reads ark's own history would show up as log, rev-list, describe, show, tag or merge-base
# with such a directory. Needs a built repository. Output: a summary on stdout; the raw log goes to
# $TRACE_DIR/git-in-repo.log (default: a scratch directory under /tmp).
set -euo pipefail
root=$(git rev-parse --show-toplevel)
dir=${TRACE_DIR:-/tmp/trace-git}
real=$(command -v git)
mkdir -p "$dir/bin"
: > "$dir/git-in-repo.log"
cat > "$dir/bin/git" <<SHIM
#!/bin/sh
case "\$PWD/" in $root/*) echo "cwd \$PWD: \$*" >> $dir/git-in-repo.log;; esac
case "\$*" in *$root*) echo "arg \$PWD: \$*" >> $dir/git-in-repo.log;; esac
exec $real "\$@"
SHIM
chmod +x "$dir/bin/git"
cd "$root"
PATH="$dir/bin:$PATH" pnpm -r run test > "$dir/test.out" 2>&1 && echo "tests: exit 0" || echo "tests: failed, see $dir/test.out"
echo "calls logged: $(wc -l < "$dir/git-in-repo.log")"
echo "by subcommand (the first word that is not an option or a path):"
sed -E 's/^(cwd|arg) [^:]*: //' "$dir/git-in-repo.log" |
  awk '{for(i=1;i<=NF;i++){ if($i=="-C"||$i=="-c"||$i ~ /^\//){i++; continue}; print $i; break}}' |
  sort | uniq -c | sort -rn
echo "history commands (log, rev-list, describe, show, tag, merge-base, blame, reflog):"
grep -cE ": (-C [^ ]+ )?(log|rev-list|describe|show|tag|merge-base|blame|reflog)( |$)" "$dir/git-in-repo.log" || true
