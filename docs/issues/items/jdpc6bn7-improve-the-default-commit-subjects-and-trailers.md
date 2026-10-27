# Improve the default commit subjects and trailers

## Problem
The commits that issues' `--commit` writes are hard to read in `git log --oneline`, and their trailers repeat themselves. Found while filing ark's first issues with 0.1.0 (rough edges 1, 2, 4, 5 and 13 of PR #22); the default `[commit] subject` is `docs(issues): {action} {title}`.

- **Two verbs with an imperative title (rough edge 1).** `open {title}` gives `docs(issues): open add the MCP server, agent skill and search to issues`, `open support SHA-256 source repositories` and `open garbage-collect unused source caches`. The README's own example title, "Split the orders service", gives `open split the orders service`. They pass commitlint but read as two commands.
- **Only the id after `open` (rough edge 2).** On a branch every other action names the issue by id: `set the scope of pcmzc2dz`, `close 66kw3dgx`, `start work on 66kw3dgx`. An issue PR's `git log --oneline` can't be read without `issues show`. The config and README call the slot `{title}`, but it holds the title only for `new` (`packages/issues/src/commit-actions.ts`).
- **A batch takes the last event's subject (rough edge 4).** Three staged `link` events committed by `scope … --commit` get the default subject `set the scope of 1w06qws8`, with four trailer pairs. PR #22 used `-m` for both of its batched commits (`link and scope the issues guardrails issue`).
- **Repeated identical trailer pairs (rough edge 5).** The same commit carries `Issue: 1w06qws8` / `Issue-Event: linked` three times. `Issue-Event` holds only the event type, so the second and third pair say nothing the first doesn't (commit `836499b` on main).
- **The shortened-subject warning misstates the limit (rough edge 13).** `issues new "Add the retry budget and the circuit breaker to the payments gateway client" --commit` warns "commit subject shortened to 72 characters; the full title is in the commit body", but the subject it writes, `docs(issues): open add the retry budget and the circuit breaker to the payments…`, is 80 characters. The limit applies to the description after `docs(issues): ` (here 66 characters, cut at a word boundary), not to the subject.

## Proposal
- `new` gets an action that reads with an imperative title, for example `add issue {title}` or the title in quotes (`open "split the orders service"`).
- Writes after `open` name the issue by more than its id, for example the title (shortened like `new`'s), and the config and README say what the slot holds for each action.
- A commit of several events gets a subject that covers them (for example `link and scope …`, or one action per distinct event type) instead of the last event's.
- One `Issue` / `Issue-Event` pair per distinct issue and event type, or pairs that differ (for example the event id), so no two pairs are identical.
- The shortened-subject warning names the limit it applies: the description after the type and scope, at most 72 characters.

## Alternatives
Keep the defaults and use `-m` or `[commit] subject`. `-m` has to be remembered on every batched commit, and `[commit] subject` only changes the template around the slot, not what the slot holds or the trailers.

## Done when
- `issues new "Split the orders service" --commit` writes a default subject that doesn't read as two verbs, with a test.
- The default subject of every write after `open` names the issue by more than its id, and the issues README and the starter `issues.toml` comment say what the title slot holds for each action.
- A `--commit` that commits several staged events of different types writes a subject that covers them, not only the last event's action, with a test.
- No commit written by `--commit` has two identical `Issue` / `Issue-Event` pairs; a test commits three staged `link` events of one issue together.
- The shortened-subject warning names the 72-character limit of the description, not of the subject, with a test.
- Every default subject still passes ark's commitlint (`commitlint.config.mjs`).
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
