/**
 * The agent skill `issues init --skill` writes (02, "Agent skill (SKILL.md)"): the judgment of
 * when to use issues' MCP tools. `skill.test.ts` keeps it equal to the block in
 * docs/02-issues-v1.md.
 */
export const SKILL_MD = `---
name: issues
description: Use when starting, continuing or finishing a piece of work, when asked what to work on next, when you find a bug or follow-up you will not fix now, and whenever asked to record, look up or close an issue.
---

# Issues

Issues in this repo are managed by issues. Issue files do not show their
own state, so never judge from the raw files whether an issue is open.
Read issues with issues_get or issues://issue/{id}.

## Before starting work

1. If the user named an issue, call issues_get. If it is a DUPLICATE,
   work on the canonical issue instead. If it is blocked, tell the user
   which issues block it before starting.
2. If the user asked what to do next, call issues_ready and propose one.
3. Call issues_for_path for the files you will touch, so you know about
   open work there.
4. Call issues_start when you begin. If it notes scope globs that match
   no tracked file, commit those files with it or fix the scope with
   issues_scope.

## While working

- Record progress, findings and decisions as issues_comment, briefly.
- When the understanding of the work changes, update the description
  with issues_update. Keep Done when accurate.
- When you find a bug or follow-up you will not fix now, search with
  issues_search (include_closed: true) first; if an issue exists,
  comment on it instead. Otherwise open an issue with issues_open
  instead of leaving a TODO. If code should point at it, add an
  // issue:<id> anchor.
- If the work implements an architectural decision, link it with
  rel implements to adr:<id>.

## Finishing work

1. Check every condition under Done when. If one is not met, say so and
   do not close.
2. Close with issues_close, resolution done, and a reason that says how
   each condition was met. The closed event belongs in the same change
   as the fix. If issues_close isn't available, or refuses with
   issue/agent-closed, the repository keeps closing to people: tell the
   user the issue is ready to close and how each condition was met.
3. If you stop without finishing, call issues_stop and comment what is
   left.

## Never

- Edit files under docs/issues/events/ or index.md by hand.
- Close an issue you did not work on, or close as wontfix or obsolete,
  without the user agreeing.
- Reopen issues. Comment why it should be reopened and tell the user.

## Without the MCP server

Use the CLI with --json: issues ready, issues search, issues for,
issues show, issues new --no-edit --section <id>=<text>, issues start,
issues comment, issues close. Set ARK_AGENT=<your name> and
ARK_ON_BEHALF_OF=<the user's email> so your writes are attributed and
the close policy applies to you.
`;
