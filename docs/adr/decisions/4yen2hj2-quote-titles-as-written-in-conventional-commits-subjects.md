# Quote titles as written in Conventional Commits subjects

## Context
ADR-0008 made `--commit` write Conventional Commits messages, and it still holds for ark's history and for repositories that enforce the rules with commitlint. It also made adr's subjects read as sentences by putting a verb in front of the title (`propose to {title}`) and lowering the title's first capital unless it looked like an acronym.

That works for an imperative title such as "Use Aurora for orders", and fails for the rest. Kiro's log has `propose to malloy is the single semantic layer…`, `propose to spotify playlist writes…` and `propose to continuous longplay is superseded…`: names lose their capital, and a title that is a statement doesn't read as a sentence after "to". No casing rule can tell "Malloy" from "Use". issues already quotes its titles (`open "…"`), but still lowers their first letter.

## Decision
`--commit` writes a Conventional Commits message by default, and a commit's title appears in its subject in double quotes, exactly as written.

- The subject comes from `[commit] subject` in `<tool>.toml`, default `docs(<tool>): {action} {title}`, where `{title}` is the title in double quotes with its casing unchanged. The description starts with the action, a lowercase verb, so it passes commitlint's default `subject-case` rule.
- adr's commands that name a decision by its title use `propose`, `accept`, `reject` and `withdraw`, as in `docs(adr): propose "Malloy is the single semantic layer"`. The others name it by its number or id, as before: `set the scope of ADR-0006`, `supersede ADR-0001 with ADR-0002`, `add a note to ADR-0003`, `deprecate ADR-0003`, `link ADR-0003 to ADR-0001`. issues keeps its actions and stops lowering the title's first letter.
- A title that would make the description longer than 72 characters is shortened inside the quotes with `…`, at a word boundary when one is near the limit, and the closing quote is kept. The body then starts with `Full title: <title>`, and a note says so. Numbers and ids are never shortened.
- `-m/--message` replaces the subject and body as given.
- The tool's trailers, such as `ADR:` and `ADR-Event:`, are always the last paragraph. ledger's git layer writes them, not `git commit --trailer`, so the user's trailer config can't move or drop them.
- ledger provides the templates (`packages/ledger/src/surfaces/commit-message.ts`), so every ledger-based tool behaves the same.

ark's own history follows Conventional Commits as `AGENTS.md` describes. CI enforces it with commitlint and `@commitlint/config-conventional` over each pull request's commits, with its default `subject-case` rule and descriptions of at most 72 characters, plus a check that fails on `fixup!` and `squash!` commits. Commits already on `main` are not linted.

## Scope
The messages of commits made by ledger-based tools: ledger's commit-message templates and commit code, each tool's `[commit]` config and the writes that commit. ark's own commit rules in `AGENTS.md` and the CI workflow that enforces them.

## Consequences
- Names, products and statements keep their meaning in subjects: `propose "Iceberg on Amazon S3 Tables…"` instead of `propose to iceberg on Amazon S3 Tables…`.
- adr's and issues' subjects take the same shape, an action and a quoted title.
- The quotes cost two of the 72 characters, so long titles are shortened slightly sooner; the full title stays in the body and in the record.
- Subjects already in a history keep their old form; only new commits change.
- A repository with other rules can still change the template or pass `--message`, and `--message` can still break a repository's commit rules.
- Exit codes are unchanged (ADR-0004).
