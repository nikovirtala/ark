# Share the index command and its freshness check in ledger

## Goal
Move the rendering, the `index/stale` check and the `index` command that adr and issues both implement into ledger. Each tool then supplies only its index spec, its projection and its words.

## Notes
Candidate 3 of ?29's comparison.

- `packages/adr/src/log-index.ts` and `packages/issues/src/log-index.ts` differ only in tool names, nouns and the index spec. The shared parts are `INDEX_RERUN`, `INDEX_BEFORE` and `INDEX_AFTER`; `render{Decision,Issue}Index` (`projectNumbering` with `MERGE_HEAD` and the committed-index fallback, then `renderIndex`); `unstagedIndexText`; `unstagedLogFiles`; `{decision,issue}IndexCheck` with its staged-mode rewrite of `index/stale`; and `run{Decision,Issue}Index` (`--check`, no commit, commit with the refresh afterwards). Both `cli/index-command.ts` files are the same apart from names and issues' `--check` help string (`packages/issues/src/cli/index-command.ts:31-34`), which adr's lacks. Option help becomes a parameter of the shared `indexCommand`, so each tool's `--help` text stays as it is.
- Domain stays in the tools: `DECISION_INDEX` and `ISSUE_INDEX`, issues' 20 most recently closed, and issues rendering without sources.
- Proposed API and placement:
  - In `packages/ledger/src/log-index/`, taking `git`, `layout` and `kind` but never a `ToolLog`: `renderLogIndex(git, { kind, layout, mainRef, tree, history, views, spec })`, `unstagedLogFiles` and `unstagedIndexText(path, files, noun)`. Type the callbacks as `views: (tree: TreeReader, numbering: Numbering) => Promise<readonly V[]>` and `spec: (root: string, views: readonly V[]) => IndexSpec<V>`: `views` is async because both tools build it with an awaited read (`await readDecisionsFrom`, `packages/adr/src/log-index.ts:159`; `await readIssuesFrom`, `packages/issues/src/log-index.ts:154-159`). adr builds the `Map` that `DECISION_INDEX` takes inside `spec`.
  - In a new `packages/ledger/src/surfaces/tool-index.ts`, with the recovery hints as functions of tool and noun:
    ```ts
    logIndexCheck(log: ToolLog, { tool, render }): Check
    runLogIndex(log: ToolLog, { tool, noun, format, index, autoCommit, commitSubject, title, action, render }, o: ToolWriteOptions & { check?: boolean }): Promise<IndexRun>
    ```
    `ToolLog` doesn't carry a tool's config, so the tool passes `index`, `autoCommit` and `commitSubject` from `log.adr` or `log.issues`, `title` and `action` from its `commit-actions.ts` (`INDEX_TITLE`, `INDEX_ACTION`), `format` (`adr-index/v1` or `issues-index/v1`), and `render(git, { tree, history })`, its `renderLogIndex` call with its spec bound. `tool` fills in `run adr index` or `run issues index`. `IndexRun` (`{ doc, refreshed }`) moves here. `ToolWriteOptions` is a new type with the fields both tools' `WriteOptions` share (`commit`, `message`, `notes`, `index?: "refresh" | "skip"`); issues' `index?: "skip"` is assignable to it, so neither tool's exported `WriteOptions` changes. These functions take a `ToolLog` (`surfaces/tool-log.ts`) and commit through `commitWithRecovery` and `renderCommitMessage` (`surfaces/`), so they can't go in `log-index/`.
  - In `packages/ledger/src/cli/`, exported from `cli/index.ts`: an `indexCommand` like `sourcesCommand` and `verifyCommand`.
  - adr's `adr://index` resource (`packages/adr/src/mcp/resources.ts:21`) can use the render the way issues' `renderIssueIndexText` does.
- Risk: this is the code under ADR-0010's invariant. These must pass unchanged: adr's `src/cli/index-invariant.*.test.ts` (seven files), `src/log-index.test.ts` and `src/cli/index-command.test.ts`; issues' `src/cli/index-invariant.test.ts`, `src/write.index.*.test.ts`, `src/log-index.test.ts` and `src/cli/index-command.test.ts`.
- The write-path lift calls `unstagedLogFiles`, `unstagedIndexText` and the recovery hints from here.
- Document the new exports in `packages/ledger/README.md`.

## Done when
- ledger exports the index render, check and run, and an `index` command for `ledger/cli`, with unit tests.
- adr and issues use them. Each tool's `log-index.ts` keeps only its index spec and the arguments it passes, and both `cli/index-command.ts` files are gone or only configure ledger's command.
- `adr index` and `issues index`, their `--json` documents (`adr-index/v1`, `issues-index/v1`) and their messages are unchanged: both tools' existing tests, the index-invariant suites included, pass with no change to what they assert.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
