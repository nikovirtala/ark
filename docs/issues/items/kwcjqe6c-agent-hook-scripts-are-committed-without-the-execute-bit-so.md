# Agent hook scripts are committed without the execute bit, so no hook runs

## Summary
`init --setup` writes `.claude/hooks/*.sh` and `.kiro/hooks/*.sh` with mode 644, and the harness configs run them directly (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/session-start.sh`, `.kiro/hooks/session-start.sh`). Without the execute bit both harnesses fail to start them, so neither the session-start nor the before-edit hook has ever run, in ark's own setup too (`git ls-files -s .claude/hooks .kiro/hooks` shows 100644).

## Steps to reproduce
1. In a fresh repository, run `adr init --setup --skill` from main.
2. `git ls-files -s .claude/hooks .kiro/hooks`.
3. Start a Claude Code or Kiro session.

## Expected
The scripts are committed as 100755, or the configs run them through `sh`, and both hooks run.

## Actual
The scripts are 100644, the hooks fail with permission denied, and the agent gets no session context and no records before edits.

## Done when
- Generated scripts are written and staged with mode 100755, and the configs also invoke them as `sh <script>` so a checkout that loses the bit still works.
- ark's committed scripts are 100755, and R9 compares modes as well as bytes.
- doctor reports a hook script that isn't executable, with the fix.
- A test runs each generated hook the way its harness does: the configured command string, from the repository root, with the harness's event JSON on stdin.
