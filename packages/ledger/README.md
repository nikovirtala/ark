# @nikovirtala/ledger

The shared core of [ark](https://github.com/nikovirtala/ark)'s ledger-based tools (adr, issues): git-backed, event-sourced records. It is internal to ark, released at 0.x, and its API is unstable until 1.0. See the [design doc](https://github.com/nikovirtala/ark/blob/main/docs/00-ark-v1.md).

Step 2 shipped the mechanical core: everything that can be specified without knowing what an event means. Step 3 adds the domain-free half of a kind: `defineKind` with the state machine as data, the fold engine, numbering, fold-aware verify checks, atomic log writes, surfaces and CLI scaffolding. A plain `KindSchema` (a name, versioned per-type `data` JSON Schemas and a body policy) still works everywhere it did, with step 2's checks.

## Entries

- `@nikovirtala/ledger`: every public function, class and type, from the layers below.
- `@nikovirtala/ledger/cli`: CLI scaffolding for tools built on ledger (`runCli`, `processIO`, `verifyCommand`). Importing a kind never loads it, because the root entry doesn't import it.
- `@nikovirtala/ledger/testing`: the test harness. It needs [fast-check](https://fast-check.dev) ^4, an optional peer dependency that the root entry never loads.

The `cli` entry re-exports `LedgerError` and `UsageError`, and the `testing` entry `LedgerError` and `InvalidArgumentError`. They are the same classes as the root entry's, so `instanceof` works across entries.

## Errors and findings

Wrong data in a repository becomes a `Finding`: `{ severity, rule, message, file, line, subject, kind }`, where `rule` is a stable `<area>/<name>` id such as `append-only/modified`. Caller misuse, invalid config and environment failures throw a `LedgerError` subclass with a fixed `code` (for example `InvalidArgumentError`, `UsageError`, `ConfigError`, `GitError`, `RefNotFoundError`, `FileExistsError`). ledger never writes to stdout or stderr.

Findings have three output formats:

- `formatText`: one `<file>[:<line>]: <severity>: <message> [<rule>] (<subject>)` line per finding, then a summary such as `4 errors, 1 warning`;
- `formatJson`: a `ledger-findings/v1` report with `ok`, `summary` and every finding, with `null` for unknown values (`findingsReport` returns the same report as an object, for embedding);
- `formatGithub`: GitHub Actions workflow-command annotations.

`exitCode(findings)` returns 1 when there is an error, and with `{ failOn: "warning" }` also when there is a warning; otherwise 0.

## Kinds

`defineKind` declares a kind with its state machine as data:

```ts
import { defineKind, eventType } from "@nikovirtala/ledger";

export const widgetKind = defineKind({
  name: "widget",
  schema: "widget/v1",
  states: ["draft", "published", "retired"],
  events: {
    created: eventType<{ title: string }>()({
      data: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
      allowedIn: [],
      to: "draft",
    }),
    published: eventType<{ body_sha256: string }>()({
      data: { type: "object", required: ["body_sha256"], properties: { body_sha256: { type: "string" } } },
      allowedIn: ["draft"],
      to: "published",
    }),
    retired: eventType()({ data: { type: "object" }, allowedIn: ["published"], to: "retired", reason: "required" }),
  },
  initial: "created",
  reduce: (state, e) => (e.type === "created" ? { title: e.data.title } : state ?? { title: "" }),
  project: (subject, ctx) => ({ id: subject.id, display: ctx.display(subject.id), status: subject.status }),
  body: { freezeOn: "published" },
  layout: { bodies: "items", events: "events" },
  defaultRoot: "docs/widgets",
  numbering: { on: "published", format: (n) => `W-${n}`, parse: (s) => Number.parseInt(s.replace(/^w-/i, ""), 10) || null },
  options: undefined,
});
```

Each event type says in which states it is allowed (`allowedIn`, or `"any"`) and which state it leads to (`to`, or `null` for events that don't change the state, such as notes). An event type can require a `reason` (`event/reason-required`). `body.freezeOn` names the event that freezes the body and records its hash. Optional parts: `invariants(subject, options)` for per-subject rules, `relate(log, options)` for rules across subjects, `templates` (`lintIn`, `lintOn`, `requireSections`) for template lint in verify, and `numbering`. `defineKind` checks the definition and throws `KindDefinitionError`, for example for an event type that names an unknown state, an event type other than the initial one with `allowedIn: []`, a freeze event that leaves the state unchanged, or a schema name not of the form `<name>/v<n>`. The result is frozen and passes `compileKind`. `kind.machine` (`terminal`, `allowed`, `next`) exposes the state machine as data, so tools can inspect it.

## Fold, projection and numbering

- **Fold.** `foldLog(kind, snapshot)` replays each subject's valid events in `(at, id)` order, independent of file names and file order, through the state machine and the kind's `reduce`. An event the machine doesn't allow is skipped and the state is unchanged; a subject whose first event isn't the initial one, or a body without events, can't be folded. `compareEvents` is the order.
- **Projection.** `projectLog(kind, folded, { numbering })` builds the kind's views and lists subjects that are `unreadable` (a newer envelope or schema) or `unfoldable`. `kindFindings` maps a kind's findings onto files.
- **Numbering.** `numberLog(git, { kind, layout, mainRef })` gives display numbers in the order the `numbering.on` event files first landed on first-parent main. Numbers are computed from file names only, never stored, and never change; a `--no-ff` merge numbers its acceptances at the merge commit. `resolveMainRef` prefers `origin/HEAD`, then `origin/main`, `origin/master`, local `main` and `master`. A shallow clone or a repository without a main branch reports numbers as unavailable (`NO_NUMBERING` with a `reason`).

## Verify

For a kind made with `defineKind`, `verifyLog` folds the head and base logs and runs `foldChecks(kind)`: step 2's mechanical checks, plus `transitions` (`transition/illegal`, `transition/not-initial`, `transition/no-events`), `invariantsCheck`, `relateCheck` and `templateCheck`. Freezing is fold-aware: only an applied freeze event freezes the body, and in a kind with bodies every subject with applied events needs one (`body/missing`). `templateCheck` lints bodies against the template version they were written with, found in the tree or in git history (`treeTemplates`, `historyTemplates`, `gitTemplates`, `templateHistoryRef`). In `staged` scope a cross-subject finding is kept when any subject it names is touched. A plain `KindSchema` gets exactly step 2's checks.

## Writes

- `writeEvents(git, layout, events, { kind })` validates a batch, refuses an event over 1 MiB, creates each file exclusively, removes the batch again if any write fails, and stages it only after every write succeeded. `writeNewFile` creates a new file (a body, a template), never overwriting one (`FileExistsError`). `nextEventIdentity` picks an `at` and ULID that sort after a subject's existing events, even with a clock that goes backwards.
- `Git.identity()` reads the configured author identity and never guesses one. `Git.commit({ message, trailers, only })` commits only the given paths, and `stagedPaths`, `unstagedPaths` and `untrackedPaths` tell a tool what a commit would take.
- **Behaviour change:** `Git.commit` now writes `trailers` itself, as a literal final paragraph of the message, instead of passing them to `git commit --trailer`. Repeated keys and their order survive any `trailer.*` git config. Don't put a trailer block of your own in `message`.
- `overlayTree(base, files)` reads a tree with some files added or replaced, so a tool can fold the log as it would be after a write before writing anything.

## Surfaces

- `openToolLog({ cwd, tool, kind, root, ref })` locates a tool's log and config: `--root`, else `[log] root` in `<repo>/<tool>.toml`, else the kind's `defaultRoot`, with `<root>/<tool>.toml` as the alternative config file. It reads config and log from the same tree (the `--ref` tree, the index or the work tree) and returns notes such as "ignoring adr.toml (its root is docs/adr; --root is fixtures/adr)".
- `resolveActor(git, { env, agent })` returns the human from the git identity, or an agent acting for it when `ARK_AGENT` (or `agent`) names one.
- `resolveSubjectInput(input, { subjects, kind, numbering })` resolves an id or a number in any form the kind parses, and says why when it can't (malformed, qualified, unknown, numbers unavailable).
- `renderStateHeader(header)` prints a subject's state line and warning, for example `ADR-0001 (a7c2m9xd) · superseded` and what to read instead.

## CLI (`@nikovirtala/ledger/cli`)

`runCli(tool, processIO())` runs one invocation of a tool defined as commands (`CommandSpec`: name, options for `node:util` `parseArgs`, positionals, and whether it reads `--ref` or refuses it). Every tool gets the same globals and exit codes: `--json` prints exactly one JSON document on stdout, `--root <dir>` and `--ref <ref>` choose the log and the tree, `-h/--help` and `-V/--version` work everywhere, and the exit code is 0 (success), 1 (failing findings, or a write the log forbids) or 2 (usage, config and environment errors, with an `ark-error/v1` document on stdout under `--json`). Notes go to stderr. `runCli` never throws. `verifyCommand({ open })` is the shared `verify [--staged | --base <ref>] [--format text|json|github]` command.

## Other layers

- **Git.** `Git.open` runs the system git (2.32.0 or newer) with fixed output settings and without the hook-exported `GIT_DIR`/`GIT_INDEX_FILE` variables. `refReader`, `indexReader`, `worktreeReader` and `MemoryTree` read a tree from a ref, the index, the work tree or memory through one `TreeReader` interface. `firstParentHistory` and `parseTrailerBlock` read commits and trailers.
- **Identity.** Subject ids are 8 lowercase Crockford base32 characters; event ids are ULIDs (in-house, monotonic). Event files are `events/<subject>/<stamp>-<rand>-<type>.yaml` and bodies `<bodies>/<subject>-<slug>.md`, under a configurable `LogLayout`. `bodySha256` hashes a body with CRLF normalized to LF.
- **Envelope.** The `ledger/v1` event envelope with its JSON Schema (`envelopeSchema`), YAML parsing and serialization (`parseEventYaml`, `serializeEvent`), and `compileKind`, which validates a kind's `data` schemas with ajv in strict mode.
- **Log.** `loadLog` turns a tree into a `LogSnapshot` of subjects, events and bodies, reporting unreadable files as findings. `writeEvent` validates an event and writes its file, never overwriting one (`EventExistsError`).
- **Mechanical verify.** `verifyLog` runs in `staged`, `range` or `full` mode: envelope and `data` schemas, identity and file names, duplicate ids, append-only event files, and the body policy (a frozen body can't change, and every freeze event's hash must match it). In staged mode only touched subjects and changed paths are checked. `verifySnapshots` runs the same checks on two snapshots, for example from `MemoryTree`s.
- **Sources.** `readToolConfig` reads `<tool>.toml` and its `[[sources]]`. `fetchSource` keeps each source in a bare cache repo under `<git common dir>/ark/sources`, pinned to its `ref`, serves the cache offline and marks it `stale` when a refetch fails. Qualified ids (`<source>:<subject>`) are parsed, formatted and resolved against the local log and the sources.
- **Templates.** Section-schema Markdown templates: `parseTemplate`, `lintTemplate`, `renderTemplate`, and `extractSections`, which reads a rendered document back into its sections (rendering and extracting round-trip). `lintDocument` checks a document against its template, `loadTemplates` reads a template directory, and `findTemplateVersion` finds an older template version in git history, for documents written against it.
- **Hooks.** One generated sh shim per git hook, shared by every ark tool. The registry of tools and their commands is embedded in the shim, and the shim runs every registered tool even after one fails. `installHooks` never overwrites a foreign hook or writes when `core.hooksPath` is set; it reports both as conflicts. `hookSnippet` prints the equivalent config for lefthook, husky or the pre-commit framework. The only default is `pre-commit: verify --staged`; there is no `pre-push` default yet.

## Testing (`@nikovirtala/ledger/testing`)

- `createTempRepo` creates hermetic temp repos (no global or system config, no outer repo); `TempRepo.env` is that environment, for spawning a tool on the repo. `forkAndMerge` builds two branch histories and merges or rebases them.
- `exampleKind` is a small `KindSchema` for tests, and `exampleMachineKind` a kind with a state machine (draft, published, retired), freezing and numbering.
- `arbLegalHistory(kind, { data, body })` generates legal histories of any kind, including same-`at` events whose file order differs from fold order; `DataArbs` supplies each event type's data from the history so far. `arbSemanticTamper` and `applySemanticTamper` add one semantic mutation (illegal transition, non-initial first event, missing reason, body without events) with the rules verify must report (`semanticExpectedRules`).
- fast-check arbitraries cover ids, envelopes, event sequences, valid log fixtures (`arbLogFixture`), appends that keep a log valid (`arbAppend`) and mechanical tamper mutations with the rules they must trigger (`arbTamper`, `applyTamper`, `expectedRules`).

## Not yet included

- **Later adr phases (step 3):** the Scope layer (globs, latest-wins `scoped` events, anchors, rename following, the set-event helper) and the Index layer (a generated index, its freshness check, and the shallow-clone number fallback) in phase 2, with the `pre-push` default, the `commit-msg` and `post-merge` hook commands, mapping `[[sources]].kind` to kinds and cross-source reference checks; the MCP scaffolding and the `@nikovirtala/ledger/mcp` entry in phase 3.
- **Later:** relations (step 5), the GitHub Action that merges findings across tools (step 6), source cache garbage collection, SHA-256 source repositories, and `template migrate`. Event-id uniqueness is checked per log, not across logs.
