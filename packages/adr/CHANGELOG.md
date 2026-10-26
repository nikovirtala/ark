# @nikovirtala/adr

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
