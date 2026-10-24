# Use Conventional Commits for --commit messages and ark's history

## Context
ark's own commits follow Conventional Commits 1.0.0, as `AGENTS.md` requires, and many projects that use adr enforce the same rules with commitlint. adr 0.1.0's `--commit` wrote subjects such as `Accept decision gyspf3an: Keep ark's tools in one monorepo`, which fail those checks, and five of them are on ark's `main`. A commit made by a tool needs a subject that passes, while keeping the trailers that `git log --grep` relies on ([Monorepo](../../00-ark-v1.md#monorepo), Shared conventions).

## Decision
`--commit` writes a Conventional Commits message by default. The subject comes from `[commit] subject` in `<tool>.toml`, default `docs(<tool>): {action} {title}`. The description starts with a lowercase letter and the rest keeps its natural casing: a title's first word loses its capital only when it is an ordinary capitalized word (`Use` becomes `use`), so a first word such as `CLI`, `ARK_AGENT` or `GraphQL` stays as written, and so does every later word (`Node 24`). For adr, the commands that name a decision by its title read as sentences (`docs(adr): propose to …`, `decide to …`, `decide not to …`, `withdraw the proposal to …`), and the others name it by its number or id (`docs(adr): set the scope of ADR-0006`, `supersede ADR-0001 with ADR-0002`, `add a note to ADR-0003`, `deprecate ADR-0003`, `link ADR-0003 to ADR-0001`). A title that would make the description longer than 72 characters is shortened with `…`, at a word boundary when one is near the limit, the body then starts with `Full title: <title>`, and a note says so; numbers and ids are never shortened. `-m/--message` replaces the subject and body as given. The tool's trailers, such as `ADR:` and `ADR-Event:`, are always the last paragraph, written by ledger's git layer rather than through `git commit --trailer`, so the user's trailer config can't move or drop them. ledger provides the templates (`packages/ledger/src/surfaces/commit-message.ts`), so every ledger-based tool behaves the same.

ark's own history follows Conventional Commits as `AGENTS.md` describes. From adr phase 2b, CI enforces it with commitlint and `@commitlint/config-conventional` over each pull request's commits, with its default `subject-case` rule and descriptions of at most 72 characters, plus a separate check that fails on `fixup!` and `squash!` commits. Commits already on `main` are not linted.

## Scope
The messages of commits made by ledger-based tools: ledger's commit-message templates and commit code, adr's `[commit]` config and the writes that commit. ark's own commit rules in `AGENTS.md` and the CI workflow that enforces them.

## Consequences
- `--commit` works in repositories that enforce Conventional Commits, and a repository with other rules can change the template or pass `--message`.
- Long titles appear shortened in `git log --oneline`; the full title stays in the commit body and in the decision.
- `--message` is used verbatim, so a message given that way can break a repository's commit rules.
- Until phase 2b, nothing in ark's CI checks commit messages, so reviewers have to.
- Exit codes are unchanged (ADR-0004).
