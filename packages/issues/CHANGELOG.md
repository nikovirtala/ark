# @nikovirtala/issues

## 0.5.2

### Patch Changes

- a8dbb8e: `adr init --skill` and `issues init --skill` add their `AGENTS.md` pointer when `--skill-dir` is the repository root and the other tool's pointer is already there. A line counts as naming the skill only when it holds the skill's path as a whole path, optionally after `./`, not as the end of a longer path: adr's `.claude/skills/adr/SKILL.md` no longer counts as naming `SKILL.md`.
  
  Changed behaviour:
  - A line that holds the skill's path only inside a longer path or URL, such as `foo/.claude/skills/issues/SKILL.md` or `SKILL.md.bak`, no longer keeps the pointer from being added.
- Updated dependencies [a8dbb8e]
  - @nikovirtala/adr@0.5.6

## 0.5.1

### Patch Changes

- 81e49d5: `adr list --since` and `issues list --since` (and so the post-merge hooks) list a subject's new events in log order, `(at, id)` as the fold applies them. Before, they were sorted by file path, so two events written in the same second could print in the wrong order, such as `[new: accepted, proposed]`. ledger exports `sortInLogOrder`, which sorts event paths that way by reading each file's `at` and `id` from a tree.
  
  Changed behaviour:
  - `since.events` in `adr-list/v1` and `issues-list/v1` is in log order, not path order.
- Updated dependencies [81e49d5]
  - @nikovirtala/ledger@0.11.0
  - @nikovirtala/adr@0.5.5

## 0.5.0

### Minor Changes

- 9ce02e5: Add the prompts issues_from_discussion and issues_breakdown to `issues mcp`, and `issues init --skill [--skill-dir <path>]`, which writes the agent skill (SKILL.md, by default `.claude/skills/issues/SKILL.md`, never overwritten) and a pointer line in AGENTS.md. The library exports `SKILL_MD`.
  
  Changed behaviour:
  - `issues-init/v1`'s `skill` is the SKILL.md path with `--skill`.

## 0.4.3

### Patch Changes

- 13f504e: Inside a git operation, first-parent history (`firstParentAdditions`, numbering's main-base lookup) and `refReader(…).list` tree listings are read once until the operation changes HEAD, a ref or the index, and `worktreeReader.list` hashes files through one `hash-object --stdin-paths` process instead of one per listing. One `issues comment` test spawns 186 git processes instead of 235 (428 before git operations). Results are unchanged.
- Updated dependencies [13f504e]
  - @nikovirtala/ledger@0.10.1
  - @nikovirtala/adr@0.5.4

## 0.4.2

### Patch Changes

- aed35b5: Every `adr` and `issues` library entry point, CLI command and MCP request now runs as one git operation, so the reads, index renders and verify of one command share one `cat-file --batch` process and the `isShallow` and `symbolicRef` answers until it changes HEAD, a ref or the index. Each MCP request gets its own operation, so nothing carries over between requests. The editor and the `adr accept` scope prompt drop what was cached. One `issues comment` test spawns 235 git processes instead of 338. Results are unchanged.
- 8bf9318: Git operations: `withGitOperation(fn)` runs `fn` as one git operation, in which every `Git` on the same repository and environment shares one `cat-file --batch` process for revision lookups and object reads, and the answers of `isShallow` and `symbolicRef`. A git command that can change HEAD, a ref or the index, run through any `Git` in the operation, drops all of it, as does `invalidateGitOperation()`; nothing is shared once `fn` settles, and a nested `withGitOperation` joins the outer one. `numberLog`, `projectNumbering` and `verifyLog` each run as a git operation, so `adr` and `issues` commands spawn fewer git processes: one `issues comment` test spawns 338 instead of 428. Results are unchanged.
- Updated dependencies [aed35b5]
- Updated dependencies [8bf9318]
  - @nikovirtala/ledger@0.10.0
  - @nikovirtala/adr@0.5.3

## 0.4.1

### Patch Changes

- 0fbf994: `compileKind` (and so `defineKind`) no longer loads ajv or compiles a kind's event-data schemas up front: each event type's schema is compiled on its first validation. `adr` and `issues` commands that validate no event, such as `--help`, start about 55–75ms faster. `CompiledKind` gains `compileAll()`, which compiles every data schema at once; call it in a kind's tests.
  
  Changed behaviour:
  - A data schema that ajv rejects (an unknown keyword in strict mode, for example) no longer makes `defineKind` or `compileKind` throw. The `KindDefinitionError` comes from the first `validate` of that event type, or from `compileAll()`. The other definition checks still throw at definition time.
- Updated dependencies [0fbf994]
  - @nikovirtala/ledger@0.9.0
  - @nikovirtala/adr@0.5.2

## 0.4.0

### Minor Changes

- 902f69c: Add `issues mcp`, an MCP server over stdio with the read tools issues_search, issues_get, issues_list, issues_ready, issues_for_path and issues_templates, and the resources `issues://index`, `issues://ready` and `issues://issue/{id}` (the id, the number, or `%3F<number>`). Tools return the CLI's `--json` documents; responses that show an issue lead with its state header, which names the canonical issue of a duplicate and the open blockers of a blocked issue. `issues_search` and `issues_list` take `source` and read it from the local cache. The library exports `listTemplates` (`issues-templates/v1`) and `renderIssueIndexText`.
- 166b3ab: Add the write tools to `issues mcp`: issues_open, issues_update, issues_comment, issues_start, issues_stop, issues_close, issues_link, issues_unlink, issues_label, issues_assign and issues_scope. Writes are recorded as the MCP client's agent, on behalf of `ARK_ON_BEHALF_OF` (else the git user, with a note), stage their files and commit only with `[policy] auto_commit`. issues_close is listed only when `[policy] mcp_can_close = true`; with `close_requires_human = true` it refuses agents (`issue/agent-closed`), and an agent's close needs a reason (`issue/agent-reason-required`). There is no reopen tool: reopening is left to people. issues_update refuses a description with unstaged changes.
  
  Changed behaviour:
  - `planEdit` and `editIssue` take `refuseIncomplete`: when set and the write commits, a description that fails template lint is refused instead of committed. The CLI doesn't set it.

## 0.3.0

### Minor Changes

- 1a82955: Add `issues search <query>… [--all] [--source <name>]`: every word must appear, ignoring case and accents, in an issue's id, number, title, description or comments. Open and in-progress issues only unless `--all`; a note counts the closed matches left out. `--source` searches a `[[sources]]` issue log from the local cache. `--json` prints `issues-search/v1`. The library exports `searchIssues`.
  
  Changed behaviour:
  - `list --source` naming a decision-log source now says `source <name> is a decision log; --source reads issue logs`.

### Patch Changes

- Updated dependencies [1a82955]
  - @nikovirtala/ledger@0.8.0
  - @nikovirtala/adr@0.5.1

## 0.2.0

### Minor Changes

- 4cc56e1: issues gets its guardrails. `issues hooks install | uninstall | print | run pre-commit | trailers` registers issues in ark's shared hook shims: pre-commit follows staged renames into scopes (`[hooks] scope_follow_renames`), checks `index.md` (or regenerates and stages it with `[hooks] index = "stage"`) and runs `verify --staged`; commit-msg adds one `Issue`/`Issue-Event` pair per staged issue and event type and `Issue: <current issue>`, and warns about "fixes ?N" without a staged close; pre-push runs `verify --fetch-sources`; post-merge runs the new `issues list --since ORIG_HEAD`, which lists issues closed, reopened or assigned to you since a revision. `[log] index = "committed"` is accepted: `issues index [--check] [--commit]` renders `index.md`, every write keeps it fresh in the same commit, and verify reports a stale one. `verify` checks scope globs (an error only for in-progress issues, so open issues may name planned code), `issue:` code anchors, and stale anchors naming closed issues; `verify --staged` checks every issue when a staged config, template or decision-log change touches them. References into other repositories are checked against ledger's source cache, with `verify --fetch-sources`, `issues sources fetch` and `issues list --source`. `issues scope --follow-renames` and `init`'s removal of an empty `.gitkeep` placeholder are new; the starter config writes `index = "none"` with a comment.
  
  Changed behaviour: default commit subjects name the issue by its title (`docs(issues): open "split the orders service"`, `docs(issues): close ?42 "split the orders service" as won't fix`), a commit sweeping in staged events of other types gets a covering subject (`link and scope ?42 "…"`), `edit`'s action is `edit`, and `unlink` says `from`. A custom `[commit] subject` that 0.1.x accepted is refused at config load if its fixed text leaves fewer than 20 characters for the title at the longest batch action (29 characters).

### Patch Changes

- Updated dependencies [4cc56e1]
- Updated dependencies [4cc56e1]
  - @nikovirtala/adr@0.5.0
  - @nikovirtala/ledger@0.7.0

## 0.1.1

### Patch Changes

- 44b0df4: A `--commit` that commits an issue's `opened` event now also commits that issue's staged description and template, and the staged events and description of any issue it references that isn't committed yet. Before, `new` without `--commit` followed by, say, `comment --commit` left the description staged, and `issues verify --ref HEAD` reported `body/missing` at that commit. `edit --commit` on an issue opened without `--commit` now takes its staged events too. The commit refuses with exit 2, before writing anything and naming the file, when one of those files has unstaged changes, isn't tracked or is missing. A committed issue's description is still never swept into an event commit.

## 0.1.0

### Minor Changes

- e53eae3: First release of issues: issue tracking kept as event logs in git, on ledger. It brings the issue kind in `@nikovirtala/issues/kind` (states `open`, `in-progress` and `closed`, the eleven event types, invariants and soft rules, the relations `depends-on`, `part-of`, `relates-to` and `implements` with derived `blocks`, `blocked`, `children`, `canonical` and ready work, numbers shown as `?42`, mutable descriptions); the library in `@nikovirtala/issues`; and the `issues` CLI with `init`, `new`, `edit`, `start`, `stop`, `close`, `reopen`, `assign`, `label`, `comment`, `link`, `unlink`, `scope`, `for`, `ready`, `work`, `list`, `show` and `verify`. `implements` links are checked against the repository's own decision log, read through `@nikovirtala/adr/kind`, so installing issues installs adr too.
  
  Not in 0.1.0: git hooks, a generated `index.md` (`[log] index = "committed"` is refused), checks over code, references into other repositories (stored, not checked), and the MCP server and agent skill.
