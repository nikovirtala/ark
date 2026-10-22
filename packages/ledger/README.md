# @nikovirtala/ledger

The shared core of [ark](https://github.com/nikovirtala/ark)'s ledger-based tools (adr, issues): git-backed, event-sourced records. It is internal to ark, released at 0.x, and its API is unstable until 1.0. See the [design doc](https://github.com/nikovirtala/ark/blob/main/docs/00-ark-v1.md).

This release is the mechanical core (roadmap step 2): everything that can be specified without knowing what an event means. Kinds plug in through a structural `KindSchema` (a name, versioned per-type `data` JSON Schemas and a body policy). The fold engine, `defineKind` and transition checks come in step 3.

## Entries

- `@nikovirtala/ledger`: every public function, class and type, from the layers below.
- `@nikovirtala/ledger/testing`: the test harness. It needs [fast-check](https://fast-check.dev) ^4, an optional peer dependency that the root entry never loads. It re-exports `LedgerError` and `InvalidArgumentError`, which are the same classes as the root entry's, so `instanceof` works across both entries.

## Errors and findings

Wrong data in a repository becomes a `Finding`: `{ severity, rule, message, file, line, subject, kind }`, where `rule` is a stable `<area>/<name>` id such as `append-only/modified`. Caller misuse, invalid config and environment failures throw a `LedgerError` subclass with a fixed `code` (for example `InvalidArgumentError`, `ConfigError`, `GitError`, `RefNotFoundError`). ledger never writes to stdout or stderr.

Findings have three output formats:

- `formatText`: one `<file>[:<line>]: <severity>: <message> [<rule>] (<subject>)` line per finding, then a summary such as `4 errors, 1 warning`;
- `formatJson`: a `ledger-findings/v1` report with `ok`, `summary` and every finding, with `null` for unknown values;
- `formatGithub`: GitHub Actions workflow-command annotations.

`exitCode(findings)` returns 1 when there is an error, and with `{ failOn: "warning" }` also when there is a warning; otherwise 0.

## Layers

- **Git.** `Git.open` runs the system git (2.32.0 or newer) with fixed output settings and without the hook-exported `GIT_DIR`/`GIT_INDEX_FILE` variables. `refReader`, `indexReader`, `worktreeReader` and `MemoryTree` read a tree from a ref, the index, the work tree or memory through one `TreeReader` interface. `firstParentHistory` and `parseTrailerBlock` read commits and trailers.
- **Identity.** Subject ids are 8 lowercase Crockford base32 characters; event ids are ULIDs (in-house, monotonic). Event files are `events/<subject>/<stamp>-<rand>-<type>.yaml` and bodies `<bodies>/<subject>-<slug>.md`, under a configurable `LogLayout`. `bodySha256` hashes a body with CRLF normalized to LF.
- **Envelope.** The `ledger/v1` event envelope with its JSON Schema (`envelopeSchema`), YAML parsing and serialization (`parseEventYaml`, `serializeEvent`), and `compileKind`, which validates a kind's `data` schemas with ajv in strict mode.
- **Log.** `loadLog` turns a tree into a `LogSnapshot` of subjects, events and bodies, reporting unreadable files as findings. `writeEvent` validates an event and writes its file, never overwriting one (`EventExistsError`).
- **Verify.** `verifyLog` runs the mechanical checks in `staged`, `range` or `full` mode: envelope and `data` schemas, identity and file names, duplicate ids, append-only event files, and the body policy (a frozen body can't change, and every freeze event's hash must match it). In staged mode only touched subjects and changed paths are checked. `verifySnapshots` runs the same checks on two snapshots, for example from `MemoryTree`s.
- **Sources.** `readToolConfig` reads `<tool>.toml` and its `[[sources]]`. `fetchSource` keeps each source in a bare cache repo under `<git common dir>/ark/sources`, pinned to its `ref`, serves the cache offline and marks it `stale` when a refetch fails. Qualified ids (`<source>:<subject>`) are parsed, formatted and resolved against the local log and the sources.
- **Templates.** Section-schema Markdown templates: `parseTemplate`, `lintTemplate`, `renderTemplate`, and `extractSections`, which reads a rendered document back into its sections (rendering and extracting round-trip). `lintDocument` checks a document against its template, `loadTemplates` reads a template directory, and `findTemplateVersion` finds an older template version in git history, for documents written against it.
- **Hooks.** One generated sh shim per git hook, shared by every ark tool. The registry of tools and their commands is embedded in the shim, and the shim runs every registered tool even after one fails. `installHooks` never overwrites a foreign hook or writes when `core.hooksPath` is set; it reports both as conflicts. `hookSnippet` prints the equivalent config for lefthook, husky or the pre-commit framework. The only default is `pre-commit: verify --staged`; there is no `pre-push` default yet.
- **Testing** (`@nikovirtala/ledger/testing`). `createTempRepo` creates hermetic temp repos (no global or system config, no outer repo). `forkAndMerge` builds two branch histories and merges or rebases them. `exampleKind` is a small kind for tests. fast-check arbitraries cover ids, envelopes, event sequences, valid log fixtures (`arbLogFixture`), appends that keep a log valid (`arbAppend`) and tamper mutations with the rules they must trigger (`arbTamper`, `applyTamper`, `expectedRules`).

## Not yet included

- **Step 3:** the fold engine, `defineKind`, transition checks, kind invariants, the orphan check, numbering, fold-aware freezing, template lint in verify, legal-history generators, semantic tamper mutations, and the merge-safety, order-independence and time-travel properties.
- **Steps 3 and 4:** CLI and MCP surfaces, mapping `[[sources]].kind` to kinds, cross-source reference checks, Index, Scope, `commit-msg` and `post-merge` hook commands, the `pre-push` default, source cache garbage collection, SHA-256 source repositories, and `template migrate`.
- **Later:** relations and set events (step 5), and the GitHub Action that merges findings across tools (step 6). Event-id uniqueness is checked per log, not across logs.
