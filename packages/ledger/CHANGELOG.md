# @nikovirtala/ledger

## 0.7.0

### Minor Changes

- 4cc56e1: Sources are read from a local cache unless verify is asked to fetch them. `readSources(git, sources, { fetch: "cache" | "network" })` never touches the network in cache mode, where a source that isn't cached reads as `null`, and in network mode fetches each source and throws `SourceFetchError` (exit 2) when a fetch fails, even with an older pin cached. Statuses record the resolved `commit` and whether it was `fetched`; `verifyCommand` gains `--fetch-sources` and reports the statuses in the `sources` field of `ledger-findings/v1`, and `sourceFindings` gives one `sources/not-fetched` warning per referenced source that isn't cached. `sourcesCommand` is the shared `<tool> sources fetch [<name>]`, and `sourcesOfKinds` picks the entries of the kinds a tool reads. `DEFAULT_HOOK_COMMANDS["pre-push"]` passes `--fetch-sources`.
  
  `verifyLog({ widenOn })` checks every subject in `staged` mode when the staged changes touch one of a tool's inputs outside the log (`touchedInputs`). A kind's `scope.requireMatchIn` (default `activeIn`) names the states whose scope globs must match tracked files. `renderCommitMessage` takes a `slot` (`before`, `after`, `quote`) and returns `note`, the shortened-title note naming the 72-character limit of the description; `joinActions` and `eventTrailers` build batch subjects and one trailer pair per subject and event type. The index-copy helpers (`holdsText`, `headBytes`, `headTree`, `writeIndexCopy`, `withoutPaths`, `firstLine`) move here from adr, and `ProjectContext.options` passes kind options to projections.
  
  Changed behaviour: a `[[sources]] ref` that starts with `-` or `+`, or holds `:`, a glob or a revision suffix, is a `ConfigError`.

## 0.6.0

### Minor Changes

- ea9e696: Add the `@nikovirtala/ledger/mcp` entry: `serveMcp` serves a tool's library functions as an MCP server over stdio, with JSON Schema input validation, the tool's JSON document as `structuredContent`, state headers before any body, `ark-error/v1` error results, one request at a time, and agent attribution from the MCP client's name (`mcpAttribution`, `mcpAgentName`). Also add `replaceFile` (replace a file only if it still holds the expected bytes), `FileChangedError` (code `file-changed`) and `replaceSections` (replace template sections in place, keeping every other line).
  
  Changed behaviour:
  - `@modelcontextprotocol/sdk` 1.32.2 is a new dependency (about 92 packages, 25 MB installed). Only the `mcp` entry loads it.
  - `LedgerErrorCode` gains `"file-changed"`; an exhaustive `switch` over it needs the new case.

## 0.5.0

### Minor Changes

- 9b2989b: Add the Index layer: generated, committed Markdown indexes (`renderIndex`, `escapeMarkdown`,
  `INDEX_FORMAT`), their numbers line (`parseIndexNumbers`, `readIndexNumbers`), the freshness check
  (`indexCheck`: `index/missing`, `index/stale`, `index/unchecked`) and `writeIndexFile`. Add
  `projectNumbering`, which numbers a tree as its commit will be numbered on main (main's numbers
  first, also on a branch that merged main), with `compareNumberingKeys`, a `not` option for
  `firstParentAdditions`, and a `fallback` for `numberLog` in shallow clones (`reason: "index"`).
  
  Add checks over code for kinds with `scope`: `scopeGlobCheck`, `anchorCheck`, and the
  `governedChanges` and `narrowedScopes` helpers, reading the repository through the new
  `CheckContext.repo` (`RepoContext`), which `verifyLog` sets. Add `Git.trackedPaths`,
  `Git.changedPaths` and an `ifExists` option for `Git.appendTrailers`; `commitWithRecovery`,
  `saveCommitRecovery` and `CommitFailedError` (`commit-failed`), which save a failed commit's
  message and give the command that finishes it, with notes that `runCli` prints as warnings and
  puts in `ark-error/v1`; `assertNoHookConflicts` and `HookConflictError` (`hook-conflict`);
  `resolveVerifyBase` in the `cli` entry; and `danglingAnchor` in the `testing` entry.
  
  ### Changed behaviour
  
  - `DEFAULT_HOOK_COMMANDS` includes `pre-push: verify --base @{upstream} --ref HEAD`, so
    `installHooks(git, { tool })` without `commands` also writes a `pre-push` shim. Pass `commands`
    to keep the previous set.
  - `verifyCommand` with an upstream base (`@{upstream}`, `@{u}`) that doesn't resolve now verifies
    against `origin`'s default branch, or the whole log without one, with a note, instead of
    exiting 2.
  - `Git.appendTrailers` always adds missing trailers at the end, whatever the user's
    `trailer.ifmissing` and `trailer.where` config.
  - `HookInstallResult.conflicts` entries have an `argv` field: the tool's command for that hook.

## 0.4.0

### Minor Changes

- a28dbe8: Add the Scope layer: a Node-independent glob dialect that matches dot-files (`parseGlob`,
  `globMatcher`, `escapeGlob`), whole-set events with latest-wins folding and the
  `--set`/`--add`/`--remove` helper (`setEventType`, `latestSet`, `applySetOp`), comment-anchor
  scanning with a per-kind `scope.keyword` (resolved as `kind.anchorKeyword`; `scanAnchors`,
  `anchorsInLine`), rename following (`stagedRenames`, `followRenames`) and the path-to-subjects
  lookup (`scopeLookup`, `scopedSubjects`). Add commit messages from a one-line Conventional Commits
  template that keeps the description within 72 characters (`readCommitTemplate`,
  `parseCommitTemplate`, `renderCommitMessage`, `checkCommitMessage`, `wrapParagraph`,
  `commitMessageText` and the `mergeTrailers` option of `Git.commit`), attribution with notes
  (`resolveAttribution`, `parseOnBehalfOf`), `Git.committerIdentity()`, and in the `cli` entry
  `COMMIT_OPTIONS`, `commitChoice` and the `confirm` prompt.
  
  ### Changed behaviour
  
  - `slugify` drops apostrophes instead of turning them into dashes: "Keep ark's tools" now gives
    `keep-arks-tools`, not `keep-ark-s-tools`. Existing files keep their names, because tools find
    bodies by id.
  - `resolveActor` reads `ARK_ON_BEHALF_OF`: with `ARK_AGENT` set, the agent acts on behalf of that
    address and no git identity is read; an address that isn't an email is a `ConfigError`. Without
    `ARK_ON_BEHALF_OF` it still uses the git identity's email.
  - `defineKind` throws `KindDefinitionError` for an invalid `scope.keyword` and for a `scope.event`
    whose data has no `set` array; a definition with such a `scope.event` was accepted before and is
    now refused.

## 0.3.0

### Minor Changes

- b241ce5: Add the domain-free half of a kind: `defineKind` with the state machine as data, the fold engine (`foldLog`, `projectLog`), numbering on first-parent main (`numberLog`), fold-aware verify checks (transitions, invariants, relations, template lint), atomic log writes (`writeEvents`, `writeNewFile`, `overlayTree`), surfaces (`openToolLog`, `resolveActor`, `resolveSubjectInput`, `renderStateHeader`), the `@nikovirtala/ledger/cli` entry (`runCli`, `verifyCommand`), and testing generators (`exampleMachineKind`, `arbLegalHistory`, `arbSemanticTamper`). Plain `KindSchema` kinds keep their step 2 checks.
  
  Behaviour change: `Git.commit` now writes `trailers` as a literal final paragraph of the message instead of passing them to `git commit --trailer`, so repeated keys and their order survive any `trailer.*` config. Don't put a trailer block of your own in `message`.

## 0.2.0

### Minor Changes

- 51f134c: Add the mechanical core: git access, subject and event identity, the `ledger/v1` envelope and its JSON Schema, log snapshots, mechanical verify checks with text, JSON and GitHub output, `[[sources]]`, section-schema templates, the shared git hook shim, and the `@nikovirtala/ledger/testing` harness. The API is internal and unstable until 1.0.

## 0.1.0

### Minor Changes

- 34e5d6e: First release: the `ENVELOPE_VERSION` constant and an empty `@nikovirtala/ledger/testing` entry. Published to prove the release pipeline; the API is internal and unstable.
