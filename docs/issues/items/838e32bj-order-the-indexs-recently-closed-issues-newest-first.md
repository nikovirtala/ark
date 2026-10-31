# Order the index's recently closed issues newest first

## Summary
`index.md` lists every section by issue number, so "Recently closed" hides the rule that picks it: the 20 issues with the latest `closed_at` (`RECENTLY_CLOSED` in `packages/issues/src/log-index.ts`). When a change closes an issue, the oldest closure drops off the list, and with number order it looks as if an unrelated issue vanished. The other sections are also in number order, not by how long an issue has been in its state.

## Steps to reproduce
1. At `1ac4c4f`, `docs/issues/index.md` lists 20 recently closed issues, ?4 to ?33, in number order.
2. Close one more issue, as pull request #69 does for ?34 (closed 2026-10-30), and run `issues index`.
3. Read the diff of `docs/issues/index.md`.

## Expected
"Recently closed" is ordered newest first by close time, so the issue that drops off is the last row. The other sections are ordered oldest first by the time their issue entered its state (the date in "Since"). The "Since" column keeps showing the date only.

## Actual
?15 (closed 2026-10-29T07:17Z) disappears from the middle of the list, between ?11 and ?16. In pull request #68, which closes three issues, ?15, ?21 and ?22 disappear from three places. Nothing in the index says these were the oldest closures. `ISSUE_INDEX.order` sorts every section by number, then `opened_at`, then id.

## Done when
- "Recently closed" in `index.md` is ordered by `closed_at`, newest first, with a stable tie-break.
- The other sections are ordered by the time their issue entered its state, oldest first, with a stable tie-break.
- The "Since" column still shows only the date.
- Which closed issues are listed does not change: still the 20 with the latest `closed_at`.
- `issues://index` and any other surface that groups "as in index.md" use the same order.
- `docs/02-issues-v1.md` "Generated index" names the order of each section and the count of recently closed issues.
- Tests in `packages/issues` cover the order of both kinds of section.
- `docs/issues/index.md` is regenerated in the same change.
