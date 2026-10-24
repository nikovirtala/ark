# @nikovirtala/adr

Architecture decision records kept as event logs in git, built on [`@nikovirtala/ledger`](https://www.npmjs.com/package/@nikovirtala/ledger). A decision is a Markdown body plus append-only event files. Its status (proposed, accepted, rejected, withdrawn, deprecated, superseded) is computed from the events, the body is frozen by its hash once accepted, and supersession chains always lead to the decision in force. See the [design doc](https://github.com/nikovirtala/ark/blob/main/docs/01-adr-v1.md).

Released at 0.x. Phase 1 ("Core") brought the decision kind, the library and the `adr` CLI with `new`, `accept`, `supersede`, `list`, `show` and `verify`. Phase 2a ("Commands and Scope") adds `init`, `reject`, `withdraw`, `deprecate`, `note`, `link`, `scope` and `for`, `accept --copy-scope`, Conventional Commits messages for `--commit`, and `ARK_ON_BEHALF_OF` for agents. Phase 2b ("Guardrails") adds git hooks (`adr hooks`), a generated `index.md` that every write keeps fresh (`adr index`), display numbers in shallow clones read from that index, `list --since`, a recovery hint when git refuses a `--commit`, and verify checks for scope globs, code anchors, changes under inactive decisions and narrowed scopes.

## Install

```sh
npm install --save-dev @nikovirtala/adr   # Node 24 or newer, git 2.32.0 or newer
npx @nikovirtala/adr --help               # or run it without installing
```

adr needs Node 24 or newer (`engines: >=24`). On older Node, npm prints an `EBADENGINE` warning and adr isn't supported.

## Layout

```
docs/adr/
  adr.toml                                   # optional config (or adr.toml at the repository root)
  index.md                                   # generated, with [log] index = "committed"
  decisions/k3f9q8a1-use-aurora-for-orders.md
  events/k3f9q8a1/20261016T081030Z-p4d2-proposed.yaml
  events/k3f9q8a1/20261016T091512Z-7aq5-accepted.yaml
  templates/nygard.md                        # copied from the built-in on first use
```

Each decision has a canonical id (`k3f9q8a1`). Accepted decisions also get a number (`ADR-0001`), assigned in the order their acceptances land on the first-parent history of main and never stored or renumbered. Commands take an id or a number in any form: `k3f9q8a1`, `7`, `0007`, `ADR-7`, `adr-0007`.

## Commands

```sh
# Set up: write adr.toml and starter templates; never overwrites a file.
adr init --template nygard --template madr --commit

# Propose: render a draft from a template, write the body and the proposed event, and stage them.
adr new "Use Aurora for orders" --section context="We need SQL." --section scope=services/orders
adr new "Use Aurora Serverless" --supersedes ADR-0002 --template madr --edit

# Accept: lint the draft, hash the body, and write accepted (plus superseded on each declared target).
adr accept k3f9q8a1 --commit

# Supersede an accepted decision by another accepted one.
adr supersede ADR-0001 --by ADR-0002 --reason "Aurora fits the query load" --commit

# End a decision's life: reject or withdraw a proposal, deprecate an accepted decision.
adr reject k3f9q8a1 --reason "Too early" --commit
adr withdraw k3f9q8a1 --commit                       # --reason is optional
adr deprecate ADR-0003 --reason "Moving to a managed service" --commit

# Annotate: a note in any state, and typed links (relates-to, refines, depends-on).
adr note ADR-0003 "Benchmarks are in the wiki" --commit
adr link ADR-0004 ADR-0002 --rel refines --commit
adr link ADR-0004 platform:k3f9q8a1                  # a decision in a configured [[sources]] log

# Scope: the code a decision governs, as globs, and which decisions govern a file.
adr scope ADR-0004 --set 'services/orders/**' --set 'libs/db/**'
adr scope ADR-0004 --add 'services/billing/**' --remove 'libs/db/**' --commit
adr scope ADR-0004 --clear
adr scope --follow-renames                           # after git mv: update the globs, stage, never commit
adr for services/orders/api.ts
adr for services/orders/api.ts --ref v1.2.0

# Read: list with computed status, show one decision with its state header.
adr list --status accepted
adr list --since ORIG_HEAD                 # only decisions with events added since a revision
adr show ADR-0001 --history
adr list --ref v1.2.0                      # time travel: the log as of any ref

# Verify the log: the whole tree, a range, or the staged changes (for a pre-commit hook).
adr verify
adr verify --base origin/main --format github
adr verify --staged

# The generated index (with [log] index = "committed"): regenerate it, or check that it is current.
adr index
adr index --check

# Git hooks: install adr in ledger's shared hook shims, or print the config for a hook manager.
adr hooks install
adr hooks print --manager lefthook
```

- `new` takes `--template <name>` (default `nygard`; built-ins `nygard`, `madr`, `y-statement`, or your own `<root>/templates/<name>.md`), `--section <id>=<markdown>` (repeatable), `--supersedes <decision>` (repeatable), and `--edit`/`--no-edit`. It opens `$VISUAL` or `$EDITOR` with `--edit`, or by default in an interactive terminal; an editor failure never loses your edits and never commits content you didn't confirm.
- `new --no-edit --commit` (or `--commit` with no editor) refuses a draft with unfilled required sections: exit 1, nothing written. Without `--commit` the draft is staged with a warning on stderr; after an editor, a draft that still has unfilled sections stays staged and isn't committed.
- `accept` of a decision that supersedes others offers their scope globs: `--copy-scope` copies them in the same write, `--no-copy-scope` doesn't, and without either it asks `[y/N]` in a terminal and otherwise prints the `adr scope … --add …` command that would copy them.
- `scope` takes `--set <glob>` (repeatable; replaces the set), `--add`/`--remove <glob>` (repeatable) or `--clear`, and stores the set sorted and deduplicated. It notes a glob that matches no tracked file and a narrowing of an accepted decision. verify requires the globs of proposed and accepted decisions to match tracked files (`scope/glob-unmatched`), so with hooks installed `adr scope <proposed> --set 'src/payments/**' --commit` for code not written yet writes and stages the scope, then fails in pre-commit with the recovery hint below, and its note says so. To finish it, commit the code the glob should match first (`git add` it, then `git commit -m "<subject>" -- <its paths>`) and then run the printed command, or `git add` the code and append its paths after `--` in the printed command. `scope --follow-renames [<decision>]` updates the globs of every decision (or one) for the staged renames, so a moved file stays governed, and only stages.
- `for <path>…` lists the decisions governing each file, from scope globs and code anchors, with a warning for decisions that aren't in force. A code anchor is a comment such as `// adr:<id>` or `# adr:<source>:<id>`: the token counts only after a comment leader on the same line (a heuristic), and anchors in binary files, submodules, the log directory and files matched by `[scope] anchor_exclude` are not found.
- Writes stage their files and don't commit, unless you pass `--commit` or set `auto_commit`. A commit holds every file of the decisions it touches (body, events, template), so `adr verify --ref <commit>` is clean, and never your unrelated staged work. It refuses with exit 2 when a file it needs has unstaged changes or isn't tracked. Its `ADR: <id>` and `ADR-Event: <type>` trailers name one event each, in a fixed order, whatever your `trailer.*` config.
- `--commit` messages follow Conventional Commits: the subject comes from `[commit] subject` (default `docs(adr): {action} {title}`, for example `docs(adr): propose to use Aurora for orders`, `docs(adr): decide to use Aurora for orders`, `docs(adr): set the scope of ADR-0003`). The description starts with a lowercase letter and the rest keeps its natural casing (`Use` becomes `use`; `CLI`, `ARK_AGENT`, `GraphQL` and `Node 24` stay). `new`, `accept`, `reject` and `withdraw` name the decision by its title (`propose to`, `decide to`, `decide not to`, `withdraw the proposal to`), while `deprecate`, `supersede`, `note`, `link` and `scope` name it by its number or id. A title that would make the description longer than 72 characters is shortened with `…`, at a word boundary when one is near the limit, the body then starts with `Full title: <title>`, and a note says so; numbers and ids are never shortened. `-m/--message <text>` replaces the subject and body as given; a message that ends in its own trailer block as git reads it, such as `Co-authored-by:` or `Refs:` lines, gets adr's trailers appended to that paragraph. The trailers are always the last paragraph, so `git log --grep "ADR: <id>"` finds a decision's commits.
- When git refuses a `--commit` (a failing hook, signing), the write stays written and staged, and adr exits 2 (`commit-failed`) with a recovery hint: git's error, the staged paths, the trailers, and the exact command that makes the commit, `git -C <top> commit --cleanup=whitespace -F <git dir>/ark/COMMIT_MSG --only -- <paths>`, with the full message saved in that file (edit it if needed, but keep the trailers). Don't run the adr command again: the log already holds the change, so a rerun would be refused, do nothing, or write it a second time. When `index.md` is among the paths, the hint ends with `Then run adr index --no-commit to restore other decisions' entries in docs/adr/index.md.` The notes the write would have reported are printed as warnings before the hint.
- With `[log] index = "committed"`, every write keeps `<root>/index.md` current: the accepted and proposed decisions, then the superseded, deprecated, rejected and withdrawn ones, each with its number, linked title, status and date, and a last line recording the numbers. A `--commit` renders it from exactly the tree the commit holds and includes it whenever the commit changes it; the work-tree copy keeps other decisions' uncommitted entries. Numbers are projected: on a branch they are the numbers its acceptances will get once it merges. `adr index` regenerates and stages it, `adr index --commit` commits it as `docs(adr): regenerate the decision index`, and `adr index --check` exits 1 when it is stale or missing.
- `list --since <rev>` lists only the decisions with event files added between `<rev>` and HEAD (or `--ref`), each with the new event types, such as `[new: accepted]`; it prints nothing when the log didn't change.
- In a shallow clone, numbers need history the clone lacks. With a committed index, adr reads them from `index.md` in the commit being read (`--ref`, else HEAD) and notes `numbers come from docs/adr/index.md (shallow clone)`; without one, decisions display by id until you run `git fetch --unshallow`. Nothing is fetched automatically.
- `hooks install` registers adr in ledger's shims, one per hook and shared with other ark tools: `pre-commit` runs `adr hooks run pre-commit`, `commit-msg` runs `adr hooks trailers` (adds `ADR:` and `ADR-Event:` trailers when event files are staged, unless the message has them or a merge is in progress), `pre-push` runs `adr verify --base @{upstream} --ref HEAD`, which checks the current branch's commits against its upstream whichever refs the push names (without an upstream, against `origin`'s default branch; with no remote, the whole log), and `post-merge` runs `adr list --since ORIG_HEAD`. It never overwrites a foreign hook (it writes the other hooks, exits 2 and names the line to add to that hook) and writes nothing when `core.hooksPath` is set (exit 2, pointing to `adr hooks print --manager lefthook|husky|pre-commit` for the hook manager in use). `hooks uninstall` removes adr from the shims. The pre-commit steps are rename following (`[hooks] scope_follow_renames`), the index (checked, or regenerated and staged with `[hooks] index = "stage"`), then `verify --staged`. The hook stages only into the commit's own index: for `git commit <paths>`, a rename that changes a decision's scope stops the commit and names the command to run. When the staged `index.md` lists decision files that aren't staged, the `index/stale` finding names them; stage them, or move them out of the work tree and run `adr index`.
- `show` leads with a state header. A decision that isn't in force says so and names what to read instead, for example `SUPERSEDED by ADR-0002 (accepted 2026-10-18). Do not apply this decision; read ADR-0002 instead.`

Every command takes `--json`, `--root <dir>` (the log directory) and `--help`; reads also take `--ref <ref>`, and writes refuse it.

## Exit codes and JSON

- **0**: success.
- **1**: failing findings from `verify` (or `index --check`, or a hook), or a write the log's rules forbid (an illegal transition, a draft that fails its template lint, an agent's acceptance, an unaccepted successor). Nothing is written, and the findings are in the output.
- **2**: the tool can't run: bad usage (unknown command, flag or decision, a missing argument, `--ref` on a write), config, environment or internal errors. Nothing is written, except when git refuses a `--commit` (`commit-failed`): the write is then staged and the error says how to finish the commit.

With `--json`, stdout carries exactly one JSON document: `adr-list/v1` (with `since`, `null` without `--since`), `adr-show/v1`, `adr-write/v1` (for every write command), `adr-for/v1`, `adr-init/v1`, `adr-index/v1`, `adr-hooks/v1`, ledger's `ledger-findings/v1` for `verify`, or `ark-error/v1` (`{ "format": "ark-error/v1", "error": { "code", "message" } }`) when the command exits 2; a `commit-failed` error also has the write's `notes`. Every key is always present, with `null` where a value is unknown. A `numbering` object's `reason` is `"index"` when a shallow clone's numbers come from `index.md`. In a shallow clone with a committed index, `adr-write/v1`'s `decision.number` comes from the index in HEAD, which on a branch is the number the acceptance will get once the branch merges. Warnings and notes go to stderr.

## Config (`adr.toml`)

Every key is optional.

```toml
[log]
root = "docs/adr"               # read from <repo>/adr.toml; the default
default_template = "nygard"
main_branch = "origin/main"     # the ref numbers come from; default origin/HEAD, origin/main, main, …
index = "none"                  # or "committed": adr index, fresh on every write, checked in verify

[policy]
accept_requires_human = true    # refuse acceptances by an agent
auto_commit = false             # commit writes without --commit
mcp_can_decide = false          # validated now, used in phase 3

[verify]
fail_on = "error"               # or "warning"
governed_by_inactive = "warning"   # or "error": a change under a superseded or deprecated decision

[commit]
subject = "docs(adr): {action} {title}"   # the default; --message overrides it

[scope]
anchor_keyword = "adr"          # the default: anchors read adr:<id>
anchor_exclude = ["**/*.md"]    # files never searched for anchors (docs that show examples); default []

[hooks]
scope_follow_renames = "stage"  # stage, warn or off: pre-commit's rename following
index = "check"                 # check, or stage to regenerate index.md in pre-commit
```

verify also checks code against the log: `scope/glob-invalid` (error) for a stored glob that doesn't parse, `scope/glob-unmatched` (error) for a glob of a proposed or accepted decision that matches no tracked file, `scope/anchor-missing` (error) for an `adr:<id>` anchor naming no decision in the log (qualified anchors are checked in ark's step 4), `decision/governed-by-inactive` (a warning, or an error with `governed_by_inactive = "error"`) for a changed file governed by a superseded or deprecated decision, and `decision/scope-narrowed` (warning) when a new scope stops covering files that still exist. Deprecated decisions' globs no longer have to match files. With `index = "committed"`, `index/missing` and `index/stale` are errors, and `index/unchecked` warns in a shallow clone without a recorded index.

`[commit] subject` is one line with `{title}` (what names the decision: its title with an ordinary capitalized first word lowercased (`Use` → `use`, so a single-capital proper noun such as `Aurora` loses that capital; `CLI`, `GraphQL` and `ARK_AGENT` stay), or its number or id), `{raw_title}` (the same with its case kept), `{action}`, `{id}`, `{display}` and `{command}`. It is checked when the config is read: at most one title placeholder, after the type and scope, and room within 72 characters for the title (20 characters) and, uncut, for the longest number-based name (`ADR-0001 to a decision in another log`); an invalid template exits 2. Whatever the template, the description's first letter is lowercased.

The config is `<repo>/adr.toml`, whose `[log] root` chooses the log directory, or `<root>/adr.toml`. `--root` uses a repository-level file that names the same root, and overrides one that names another root with a warning.

## Agents

An agent using the CLI sets `ARK_AGENT=<agent-id>`, and `ARK_ON_BEHALF_OF=<email>` for the person it acts for. Its events are recorded as the agent, acting on behalf of that address. Without `ARK_ON_BEHALF_OF` they are recorded on behalf of the git user, and every write says so in a note on stderr and in the JSON `notes`: `on_behalf_of taken from the git identity <email>; set ARK_ON_BEHALF_OF to name who you act for`. An `ARK_ON_BEHALF_OF` that isn't an email address exits 2 before anything is written; without `ARK_AGENT` it is ignored, with a note. With `accept_requires_human` on (the default), `adr accept` refuses an agent with exit 1 (`decision/agent-accepted`), and `adr new` tells the agent to ask a human to review and accept.

The git identity is git's author identity (`git var GIT_AUTHOR_IDENT` with `user.useConfigOnly`): `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` when set, else `user.name` and `user.email`; it is never guessed. Setting `GIT_AUTHOR_*` also changes the author of `--commit` commits, which is why agents should use `ARK_ON_BEHALF_OF` instead. `--commit` also needs a committer identity, and exits 2 before writing without one.

## Library

The CLI is a thin layer over the library, and phase 3's MCP server uses the same functions and returns the same JSON documents.

```ts
import { listDecisions, openDecisionLog, readDecisions, showDecision, verifyDecisions } from "@nikovirtala/adr";

const log = await openDecisionLog({ cwd: process.cwd() });
const read = await readDecisions(log);
const { decisions } = listDecisions(read, { status: ["accepted"] });
const findings = await verifyDecisions(log, { type: "full" });
```

`initDecisionLog`, `proposeDecision`, `acceptDecision`, `rejectDecision`, `withdrawDecision`, `deprecateDecision`, `supersedeDecision`, `noteDecision`, `linkDecision`, `scopeDecision` and `followScopeRenames` write, `decisionsFor` answers `adr for`, `resolveDecision` turns an id or number into an id, and `stateHeader` gives the header `show` prints. `indexDecisionLog` and `renderDecisionIndex` regenerate or render the index, and `installDecisionHooks`, `uninstallDecisionHooks`, `printDecisionHooks`, `runPreCommitHook` and `addHookTrailers` are the hook commands.

`@nikovirtala/adr/kind` exports only the decision kind (`adrKind`, made with ledger's `defineKind`) and its types, without any CLI code, for tools that fold decision logs themselves, such as issues linking to decisions:

```ts
import { adrKind } from "@nikovirtala/adr/kind";
```

## Not yet included

- **Reference checks are local.** `verify` checks that `supersedes`, `superseded.by` and `linked.to` name decisions in the same log. Qualified references to other logs (`<source>:<id>`, written by `adr link`) and qualified anchors are skipped until ark's step 4.
- **Phase 3:** an MCP server, a SKILL.md for agents, and search.
- **ark's step 4, with issues:** cross-log reference checks at the pinned ref and listing across sources; until then `link` stores a qualified target unchecked.
