# Commit a staged issue description with its events

## Summary
When an issue was opened without `--commit`, a later write to it with `--commit` commits every staged event of the issue, `opened` included, but leaves the staged description `items/<id>-<slug>.md` out. That commit fails `verify` with `body/missing`, so `git bisect` and `git rebase --exec` stop on it. Rough edge 3 of PR #22, where `issues new`, `issues link …` and then `issues scope … --commit` did this.

## Steps to reproduce
With `@nikovirtala/issues@0.1.0` on Node 24.21.0, `ARK_AGENT=kiro`, in a new repository with one commit on `main`:

1. `issues init --commit`
2. `issues new "Split the orders service" --section goal=x --section done=y` (no `--commit`): stages the `opened` event and `docs/issues/items/<id>-split-the-orders-service.md`.
3. `issues scope <id> --set "src/**"` (no `--commit`).
4. `issues comment <id> "first" --commit`
5. `git show --stat HEAD`, then `issues verify --ref HEAD`.

## Expected
The commit holds the description next to the `opened` event, and `issues verify --ref HEAD` exits 0. Or, if issues shouldn't pull the file in, `comment --commit` refuses before writing anything and names the staged description that has to come along.

## Actual
The commit takes the three staged events with their trailers and no description, which stays staged:

```
$ git show --stat --format=%s HEAD
docs(issues): comment on z9abt8ps

 .../events/z9abt8ps/20261027T082821Z-2yzt-opened.yaml   | 17 +++++++++++++++++
 .../events/z9abt8ps/20261027T082822Z-e0f3-scoped.yaml   | 16 ++++++++++++++++
 .../z9abt8ps/20261027T082824Z-8qrk-commented.yaml       | 15 +++++++++++++++
 3 files changed, 48 insertions(+)

$ issues verify --ref HEAD        # exit 1
docs/issues/events/z9abt8ps/20261027T082821Z-2yzt-opened.yaml: error: body file is missing [body/missing] (z9abt8ps)

1 error, 0 warnings

$ git status --short
A  docs/issues/items/z9abt8ps-split-the-orders-service.md
```

`applyPlan` (`packages/issues/src/apply.ts`) commits the plan's files plus the staged files under the plan's `commitScope`, and an event write's `commitScope` is only the issue's events directory (`packages/issues/src/plan.ts`), so the staged description is never considered.

## Done when
- A `--commit` that commits an issue's staged `opened` event also commits that issue's staged description, or refuses with exit 2 before writing anything and names the file. No `--commit` creates a commit at which `issues verify --ref HEAD` reports `body/missing`.
- A test in `packages/issues` runs the steps above (and `new`, `link`, then `scope --commit`, as in PR #22) and checks the files of the commit and `verify --ref HEAD`.
- The fix carries a patch changeset for `@nikovirtala/issues`, so it ships as 0.1.1, and it merges before issues PR 2 (`?3`, `1w06qws8`), which depends on this issue.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
