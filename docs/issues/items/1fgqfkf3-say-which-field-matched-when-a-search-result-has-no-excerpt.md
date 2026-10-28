# Say which field matched when a search result has no excerpt

## Goal
Make `issues search` and `adr search` say which field matched when a result has no excerpt, instead of printing an empty `( match)` line (low finding of the review of issues PR 3a, ?13).

## Notes
- When a result's excerpt is null, issues' and adr's `searchText` print `(<field> match)` keeping only the id and title fields (`packages/issues/src/cli/text.ts`, `packages/adr/src/cli/text.ts`, `packages/adr/src/mcp/text.ts`).
- The search counts body hits in `#` heading lines but leaves those lines out of the excerpt (`!l.startsWith("#")` in `packages/issues/src/search.ts` and `packages/adr/src/search.ts`). A term that appears only in a heading such as `## Done when` gives `matched: ["body"]`, excerpt null, and the line `  ( match)`.
- Reproduced in ark: `node packages/issues/dist/cli.js search when --all` prints `( match)` for several of its 16 results, and `node packages/adr/dist/cli.js search consequences --all` prints it 16 times.

## Done when
- Neither `issues search` nor `adr search` (CLI or MCP text) prints an empty `( match)` line: a result whose hits are only in description headings shows a matching excerpt or names the field (for example `(description heading match)`), with a CLI test in each tool covering a heading-only match.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
