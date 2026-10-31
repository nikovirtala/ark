# @nikovirtala/ledger

## 0.13.0

### Minor Changes

- ecbc2fe: A `[[sources]]` entry may point at a SHA-256 repository. Each source cache uses its source's object format, and a cache whose format no longer matches its source is recreated. `Git.initBare` takes `{ objectFormat }`.
  
  Changed behaviour:
  - A SHA-256 source fetches, pins and reads instead of failing with `cannot fetch source … mismatched algorithms`.
  - A cache whose source changed object format is recreated, and its old pin is dropped instead of being served as stale.

## 0.12.0

### Minor Changes

- 7e40dba: An issue's description no longer keeps empty optional sections. ledger's `renderTemplate` and `replaceSections` take `emptyOptional: "drop"`, which leaves an optional section without content out of a render, lets `replaceSections` remove one given empty text, and inserts an absent one in template order; the default `"keep"` behaves as before.
  
  Changed behaviour:
  - `issues new` and `issues_open` write no heading for an optional section without content, such as task's Notes or feature's Alternatives.
  - `issues edit --section <id>=` and `issues_update` with empty text remove an optional section, and text adds it back in the template's order.
  - `issues edit --title`/`--section` that commits refuses a description that fails template lint, such as an empty required section, as `issues new` does (exit 1, nothing written).
- 6b3e759: `issues <command> --help` describes every option: string options name their value (`--rel <rel>`, `--section <id>=<markdown>`), enumerated values and defaults are in the text, and `--no-commit`, `--no-edit` and `--no-comments` have their own rows. ledger's `CommandSpec` options are `CommandOption`s, which add `help`, `value` and `negatedHelp` for `runCli`'s command help; `COMMIT_OPTIONS` and `verifyCommand` describe their options, so adr's `--commit`, `--no-commit`, `-m` and `verify` options are described too.
  
  Changed behaviour:
  - The blocked warning says "Finish it first." when one open issue blocks, and "Finish them first." for more.
  - `issues show --history` and `issues_get` with `include_history` name on whose behalf an agent acted: `opened by kiro on behalf of <address>`.
- 9b3ce15: `issues list --source <name>`, `issues search --source <name>`, `adr list --source <name>` and `adr search --source <name>` say that a cached source has no committed `index.md` when that is why its numbers are unavailable, for example `issue numbers are unavailable (platform has no committed index.md); issues display by id`, instead of "no main branch". ledger exports `NO_INDEX_NUMBERING`, whose `reason` is `"no-index"`.
  
  Changed behaviour:
  - `numbering.reason` in `issues-list/v1` and `adr-list/v1` is `"no-index"` for a `--source` log without a committed index.
  - `adr search --source <name>` prints the note for such a source.

## 0.11.0

### Minor Changes

- 81e49d5: `adr list --since` and `issues list --since` (and so the post-merge hooks) list a subject's new events in log order, `(at, id)` as the fold applies them. Before, they were sorted by file path, so two events written in the same second could print in the wrong order, such as `[new: accepted, proposed]`. ledger exports `sortInLogOrder`, which sorts event paths that way by reading each file's `at` and `id` from a tree.
  
  Changed behaviour:
  - `since.events` in `adr-list/v1` and `issues-list/v1` is in log order, not path order.

## 0.10.1

### Patch Changes

- 13f504e: Inside a git operation, first-parent history (`firstParentAdditions`, numbering's main-base lookup) and `refReader(…).list` tree listings are read once until the operation changes HEAD, a ref or the index, and `worktreeReader.list` hashes files through one `hash-object --stdin-paths` process instead of one per listing. One `issues comment` test spawns 186 git processes instead of 235 (428 before git operations). Results are unchanged.

## 0.10.0

### Minor Changes

- 8bf9318: Git operations: `withGitOperation(fn)` runs `fn` as one git operation, in which every `Git` on the same repository and environment shares one `cat-file --batch` process for revision lookups and object reads, and the answers of `isShallow` and `symbolicRef`. A git command that can change HEAD, a ref or the index, run through any `Git` in the operation, drops all of it, as does `invalidateGitOperation()`; nothing is shared once `fn` settles, and a nested `withGitOperation` joins the outer one. `numberLog`, `projectNumbering` and `verifyLog` each run as a git operation, so `adr` and `issues` commands spawn fewer git processes: one `issues comment` test spawns 338 instead of 428. Results are unchanged.

### Patch Changes

- aed35b5: Every `adr` and `issues` library entry point, CLI command and MCP request now runs as one git operation, so the reads, index renders and verify of one command share one `cat-file --batch` process and the `isShallow` and `symbolicRef` answers until it changes HEAD, a ref or the index. Each MCP request gets its own operation, so nothing carries over between requests. The editor and the `adr accept` scope prompt drop what was cached. One `issues comment` test spawns 235 git processes instead of 338. Results are unchanged.

## 0.9.0

### Minor Changes

- 0fbf994: `compileKind` (and so `defineKind`) no longer loads ajv or compiles a kind's event-data schemas up front: each event type's schema is compiled on its first validation. `adr` and `issues` commands that validate no event, such as `--help`, start about 55–75ms faster. `CompiledKind` gains `compileAll()`, which compiles every data schema at once; call it in a kind's tests.
  
  Changed behaviour:
  - A data schema that ajv rejects (an unknown keyword in strict mode, for example) no longer makes `defineKind` or `compileKind` throw. The `KindDefinitionError` comes from the first `validate` of that event type, or from `compileAll()`. The other definition checks still throw at definition time.

## 0.8.1

### Patch Changes

- 48e84f3: `serializeEvent` writes event YAML that `biome format` (2.6.2) leaves as it is, so the commit that adds an event passes `biome check`. Event files already written don't change, and strings other than the ones below are written as before.
  
  Changed behaviour:
  
  - A string with both quote kinds that needs quoting is single-quoted (`'it''s: "both"'`) instead of double-quoted with `\"` escapes.
  - A multi-line string with an empty first line, two or more trailing newlines, or a line of only spaces and tabs is double-quoted with `\n` escapes instead of written as a block scalar. Before, biome stripped such lines' whitespace, and `" \n"` was written as a block that read back as `"\n"`.
  - A string that starts or ends with Unicode whitespace YAML doesn't count as whitespace (such as U+00A0 or U+2028) is quoted, so biome doesn't trim it.
  - A string with U+FEFF is double-quoted with that character escaped as `\uFEFF`. Before, it was written as it is, which YAML allows only at the start of a stream.

## 0.8.0

### Minor Changes

- 1a82955: Add `foldText`, `searchTerms`, `countOccurrences` and `searchExcerpt` (and the `FoldedText` type) to ledger's root entry: the case- and accent-insensitive folding, query rules and excerpts of adr's search, shared so every ledger-based tool's search matches the same way. adr's search now uses them; its results and messages are unchanged.

## 0.7.1

### Patch Changes

- 80c4b86: `Git.commit` with `mergeTrailers` now asks the installed git whether the message's last paragraph holds trailers (`git interpret-trailers --parse --no-divider`, one call, made only when there are trailers to merge). It no longer follows ledger's copy of git's rules, which git 2.56 changed: git 2.56 doesn't read a line starting with a URL (`https://…`) as a trailer, so on git 2.56 ledger merged its trailers into a paragraph that git then read as having no trailers at all. `Git.commitMessage(o)` returns the exact text `Git.commit` sends, and `commitWithRecovery` saves that text. 0.7.0 was never published (its release failed on git 2.56), so 0.7.1 is the first release with 0.7.0's changes.
  
  Changed behaviour:
  
  - The user's `trailer.separators`, `trailer.<key>.key` and `core.commentChar` config now count when deciding, as they do when git reads the commit.
  - A last paragraph whose only trailer-like lines are `(cherry picked from commit …)` lines gets the trailers in their own paragraph. git reads the same trailers as before.
  - `commitMessageText(message, trailers, { merge })` only formats: `merge` appends to the last paragraph. Its `mergeTrailers` option is gone.
  - When git can't run `interpret-trailers`, the write fails with that `GitError` before anything is committed.

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
