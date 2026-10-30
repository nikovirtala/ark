# @nikovirtala/adr

## 0.5.7

### Patch Changes

- 6b3e759: `issues <command> --help` describes every option: string options name their value (`--rel <rel>`, `--section <id>=<markdown>`), enumerated values and defaults are in the text, and `--no-commit`, `--no-edit` and `--no-comments` have their own rows. ledger's `CommandSpec` options are `CommandOption`s, which add `help`, `value` and `negatedHelp` for `runCli`'s command help; `COMMIT_OPTIONS` and `verifyCommand` describe their options, so adr's `--commit`, `--no-commit`, `-m` and `verify` options are described too.
  
  Changed behaviour:
  - The blocked warning says "Finish it first." when one open issue blocks, and "Finish them first." for more.
  - `issues show --history` and `issues_get` with `include_history` name on whose behalf an agent acted: `opened by kiro on behalf of <address>`.
- 9b3ce15: `issues list --source <name>`, `issues search --source <name>`, `adr list --source <name>` and `adr search --source <name>` say that a cached source has no committed `index.md` when that is why its numbers are unavailable, for example `issue numbers are unavailable (platform has no committed index.md); issues display by id`, instead of "no main branch". ledger exports `NO_INDEX_NUMBERING`, whose `reason` is `"no-index"`.
  
  Changed behaviour:
  - `numbering.reason` in `issues-list/v1` and `adr-list/v1` is `"no-index"` for a `--source` log without a committed index.
  - `adr search --source <name>` prints the note for such a source.
- Updated dependencies [7e40dba]
- Updated dependencies [6b3e759]
- Updated dependencies [9b3ce15]
  - @nikovirtala/ledger@0.12.0

## 0.5.6

### Patch Changes

- a8dbb8e: `adr init --skill` and `issues init --skill` add their `AGENTS.md` pointer when `--skill-dir` is the repository root and the other tool's pointer is already there. A line counts as naming the skill only when it holds the skill's path as a whole path, optionally after `./`, not as the end of a longer path: adr's `.claude/skills/adr/SKILL.md` no longer counts as naming `SKILL.md`.
  
  Changed behaviour:
  - A line that holds the skill's path only inside a longer path or URL, such as `foo/.claude/skills/issues/SKILL.md` or `SKILL.md.bak`, no longer keeps the pointer from being added.

## 0.5.5

### Patch Changes

- 81e49d5: `adr list --since` and `issues list --since` (and so the post-merge hooks) list a subject's new events in log order, `(at, id)` as the fold applies them. Before, they were sorted by file path, so two events written in the same second could print in the wrong order, such as `[new: accepted, proposed]`. ledger exports `sortInLogOrder`, which sorts event paths that way by reading each file's `at` and `id` from a tree.
  
  Changed behaviour:
  - `since.events` in `adr-list/v1` and `issues-list/v1` is in log order, not path order.
- Updated dependencies [81e49d5]
  - @nikovirtala/ledger@0.11.0

## 0.5.4

### Patch Changes

- 13f504e: Inside a git operation, first-parent history (`firstParentAdditions`, numbering's main-base lookup) and `refReader(…).list` tree listings are read once until the operation changes HEAD, a ref or the index, and `worktreeReader.list` hashes files through one `hash-object --stdin-paths` process instead of one per listing. One `issues comment` test spawns 186 git processes instead of 235 (428 before git operations). Results are unchanged.
- Updated dependencies [13f504e]
  - @nikovirtala/ledger@0.10.1

## 0.5.3

### Patch Changes

- aed35b5: Every `adr` and `issues` library entry point, CLI command and MCP request now runs as one git operation, so the reads, index renders and verify of one command share one `cat-file --batch` process and the `isShallow` and `symbolicRef` answers until it changes HEAD, a ref or the index. Each MCP request gets its own operation, so nothing carries over between requests. The editor and the `adr accept` scope prompt drop what was cached. One `issues comment` test spawns 235 git processes instead of 338. Results are unchanged.
- 8bf9318: Git operations: `withGitOperation(fn)` runs `fn` as one git operation, in which every `Git` on the same repository and environment shares one `cat-file --batch` process for revision lookups and object reads, and the answers of `isShallow` and `symbolicRef`. A git command that can change HEAD, a ref or the index, run through any `Git` in the operation, drops all of it, as does `invalidateGitOperation()`; nothing is shared once `fn` settles, and a nested `withGitOperation` joins the outer one. `numberLog`, `projectNumbering` and `verifyLog` each run as a git operation, so `adr` and `issues` commands spawn fewer git processes: one `issues comment` test spawns 338 instead of 428. Results are unchanged.
- Updated dependencies [aed35b5]
- Updated dependencies [8bf9318]
  - @nikovirtala/ledger@0.10.0

## 0.5.2

### Patch Changes

- 0fbf994: `compileKind` (and so `defineKind`) no longer loads ajv or compiles a kind's event-data schemas up front: each event type's schema is compiled on its first validation. `adr` and `issues` commands that validate no event, such as `--help`, start about 55–75ms faster. `CompiledKind` gains `compileAll()`, which compiles every data schema at once; call it in a kind's tests.
  
  Changed behaviour:
  - A data schema that ajv rejects (an unknown keyword in strict mode, for example) no longer makes `defineKind` or `compileKind` throw. The `KindDefinitionError` comes from the first `validate` of that event type, or from `compileAll()`. The other definition checks still throw at definition time.
- Updated dependencies [0fbf994]
  - @nikovirtala/ledger@0.9.0

## 0.5.1

### Patch Changes

- 1a82955: Add `foldText`, `searchTerms`, `countOccurrences` and `searchExcerpt` (and the `FoldedText` type) to ledger's root entry: the case- and accent-insensitive folding, query rules and excerpts of adr's search, shared so every ledger-based tool's search matches the same way. adr's search now uses them; its results and messages are unchanged.
- Updated dependencies [1a82955]
  - @nikovirtala/ledger@0.8.0

## 0.5.0

### Minor Changes

- 4cc56e1: References into other repositories' decision logs are checked against ledger's source cache: `adr verify` checks cached sources and warns once per uncached one (`sources/not-fetched`), `adr verify --fetch-sources` fetches first and exits 2 when a fetch fails, and `adr sources fetch` refreshes the cache (entries of other kinds are skipped). `adr list --source`, `adr search --source` and the MCP list tool read a cached source. `adr verify --staged` checks every decision when the staged changes touch `adr.toml` or the templates. A commit that sweeps in staged events of other types gets a subject naming them (`docs(adr): link and scope ADR-0003`, `update ADR-0003` beyond three verbs, or the title form of a swept-in status event), its trailers have one pair per decision and event type, and the shortened-title note names the 72-character limit of the description. Single-action subjects are unchanged.
  
  Changed behaviour:
  
  - A proposed decision's scope globs may name code that doesn't exist yet: `scope/glob-unmatched` is reported only for accepted decisions, and `adr accept` notes each glob that still matches nothing.
  - `verify` reports `decision/unknown-source` (error) for a qualified reference into a source that isn't in `[[sources]]`, which 0.4.0 skipped, so a log with such a reference starts failing.
  - The stricter `[[sources]] ref` rule of ledger.
  - The pre-push hook passes `--fetch-sources`; rerun `adr hooks install` to update an installed hook. With a configured source, pushing offline then exits 2; `git push --no-verify` skips it, and CI stays the guard.

### Patch Changes

- Updated dependencies [4cc56e1]
  - @nikovirtala/ledger@0.7.0

## 0.4.0

### Minor Changes

- ea9e696: Add `adr mcp`, an MCP server over stdio with the tools adr_search, adr_get, adr_list, adr_templates, adr_propose, adr_update_draft, adr_note, adr_link, adr_for_path, adr_scope and adr_withdraw, plus adr_accept, adr_reject, adr_deprecate and adr_supersede when `[policy] mcp_can_decide = true`; the resources `adr://index` and `adr://decision/{id}` (id, number or ADR-NNNN); and the prompt adr_draft_from_discussion. Tools return the same JSON documents as the CLI's `--json`. Add `adr search <query>… [--all]`, and `adr init --skill [--skill-dir <path>]`, which writes SKILL.md and a pointer line in AGENTS.md. New library functions: `searchDecisions`, `listTemplates`, `updateDraft`, `sourcesNote`, `SKILL_MD`.
  
  Changed behaviour:
  - `adr list`, `adr for` and `adr search` add a note (stderr and JSON `notes`) when `[[sources]]` are configured: only the local log is read until ark's step 4.
  - `adr-write/v1`'s `command` can be `"update"`; `adr-init/v1` gains `skill`; `DecisionsRead` gains `sources`.
  - Installing adr now installs `@modelcontextprotocol/sdk` through `@nikovirtala/ledger`.

### Patch Changes

- Updated dependencies [ea9e696]
  - @nikovirtala/ledger@0.6.0

## 0.3.0

### Minor Changes

- 9b2989b: adr phase 2b, "Guardrails". With `[log] index = "committed"`, `adr index` writes a generated
  `index.md` (accepted and proposed decisions, then inactive ones, with numbers, linked titles,
  status and date), every write keeps it fresh, `adr index --check` and `verify` check it, and
  `adr index --commit` commits it. Its numbers are projected: on a branch, the numbers its acceptances
  will get once it merges, after main's, also on a branch that merged main. A write notes when the
  staged `index.md` lists another decision's files that aren't staged. In a shallow clone, display
  numbers come from `index.md` in the commit being read, with a note; nothing is fetched
  automatically.
  
  `adr hooks install|uninstall|print|run|trailers` installs adr in ledger's shared hook shims:
  `pre-commit` runs rename following, the index step and `verify --staged`; `commit-msg` adds the
  `ADR:`/`ADR-Event:` trailers; `pre-push` verifies against the upstream (or `origin`'s default
  branch, or the whole log); `post-merge` runs the new `adr list --since ORIG_HEAD`, which lists the
  decisions with events added since a revision. `hooks print --manager lefthook|husky|pre-commit`
  prints the config for a hook manager instead. New config: `[hooks] scope_follow_renames`
  (`stage`, `warn`, `off`) and `[hooks] index` (`check`, `stage`).
  
  When git refuses a `--commit` (a hook, signing), adr saves the message to
  `<git dir>/ark/COMMIT_MSG` and prints the exact command that finishes the commit, why rerunning
  adr won't, and the notes the write would have reported.
  
  verify gains checks over code: `scope/glob-invalid`, `scope/glob-unmatched` for proposed and
  accepted decisions, `scope/anchor-missing`, `decision/governed-by-inactive` (a warning, or an
  error with `[verify] governed_by_inactive = "error"`) and the `decision/scope-narrowed` warning.
  
  ### Changed behaviour
  
  - `[log] index = "committed"` (accepted but unused in 0.2.0) now makes verify require a current
    `index.md`. Run `adr index` and commit it.
  - verify can fail on unmatched or invalid scope globs and dangling `adr:` anchors. Fix the globs
    or anchors, or exclude docs that show examples with `[scope] anchor_exclude`.
  - Deprecated decisions' globs no longer have to match files (`activeIn` is proposed and
    accepted).
  - A refused `--commit` exits 2 with `commit-failed` and the recovery hint instead of
    `git-failed`; the write stays staged. With `--json`, the `ark-error/v1` document also has the
    write's `notes`.
  - `adr scope --set <glob>` for a glob that matches no tracked file now notes that verify reports
    `scope/glob-unmatched` until a file matches, so with hooks installed its `--commit` fails in
    pre-commit.

### Patch Changes

- Updated dependencies [9b2989b]
  - @nikovirtala/ledger@0.5.0

## 0.2.0

### Minor Changes

- a28dbe8: adr phase 2a, "Commands and Scope". New commands: `init` (config and starter templates, never
  overwrites), `reject`, `withdraw`, `deprecate`, `note`, `link` (typed links, also to decisions in
  a configured source), `scope` (`--set`, `--add`, `--remove`, `--clear`, and `--follow-renames`,
  which updates globs for staged renames and only stages) and `for` (the decisions governing files,
  from scope globs and `adr:<id>` code anchors, with `--ref`). `accept --copy-scope` copies the scope
  of the decisions it supersedes; without the flag it asks on a terminal and otherwise prints the
  `adr scope` command.
  
  `--commit` writes Conventional Commits messages (`docs(adr): propose to <title>`,
  `docs(adr): decide to <title>`, `docs(adr): set the scope of ADR-0003`, …) from `[commit] subject`
  in `adr.toml`. The description starts with a lowercase letter and the rest keeps its natural
  casing. A long title is shortened with `Full title:` in the body, and `-m/--message` replaces the
  message; a message that ends in its own trailers gets adr's trailers appended to them.
  `[scope] anchor_keyword` and `anchor_exclude` configure code anchors. Agents can set
  `ARK_ON_BEHALF_OF=<email>` next to `ARK_AGENT`; without it, every agent write notes that
  `on_behalf_of` came from the git identity, and an invalid address exits 2. `--commit` checks for
  an author and a committer identity before writing anything.
  
  Fixes for 0.1.0: `new` by an agent tells it to ask a human to accept, `new` warns on stderr about
  unfilled sections, and `show` says "no globs recorded" with the `adr scope` command instead of
  "Applies to: none".
  
  ### Changed behaviour
  
  - `--commit` subjects are now Conventional Commits; the old `Propose decision <id>: <title>` and
    `Accept decision <id>: <title>` subjects are gone. The `ADR:`/`ADR-Event:` trailers are
    unchanged, so `git log --grep "ADR: <id>"` still works. To keep another form, set
    `[commit] subject` in `adr.toml`.
  - `adr new --no-edit --commit` (or `--commit` without an editor) with unfilled required sections
    now exits 1 and writes nothing. Pass every required section with `--section`, or drop
    `--commit` and edit the draft. After an editor, a draft that still has unfilled sections stays
    staged and isn't committed.

### Patch Changes

- Updated dependencies [a28dbe8]
  - @nikovirtala/ledger@0.4.0

## 0.1.0

### Minor Changes

- b241ce5: First release (adr phase 1, "Core"): the decision kind on ledger (`@nikovirtala/adr/kind`), the library the CLI and the later MCP server share, and the `adr` CLI with `new`, `accept`, `supersede`, `list`, `show` and `verify`. Decisions are event logs in git: status is computed from the events, accepted bodies are frozen by their hash, numbers are assigned when an acceptance lands on main, and supersession chains lead to the decision in force. Writes stage by default and commit only with `--commit` or `auto_commit`, with exact `ADR`/`ADR-Event` trailers.

### Patch Changes

- Updated dependencies [b241ce5]
  - @nikovirtala/ledger@0.3.0
