# Let a code owner's pull request approval stand for a human's accept

## Context
With `[policy] accept_requires_human = true` (the default) adr refuses an accept written by an agent; with `false` an agent may accept with no person involved. Feedback from Kiro: a person had told the agent to accept a decision, and there was no path between "refused" and turning the policy off.

Its suggestion, `adr accept --confirm-by <email>`, would record an approval that nobody can check: an agent can type any address. What a repository can check is review. Every change in a repository that uses ark reaches its main branch through a pull request, and a forge can require a code owner to approve it: ark itself has code owners for `docs/`.

## Decision
`accept_requires_human` takes a third value, `"review"`.

- With `"review"`, an agent may write the accepted event. It is recorded as the agent acting for the person it names (ADR-0007), and it takes effect when the pull request that carries it merges.
- The human's acceptance is a code owner's approval of that pull request, enforced by the forge's branch protection, not by adr.
- `adr verify` warns when the policy is `"review"` and no `CODEOWNERS` entry covers the decision log, because then nothing requires that approval.
- An agent's accept under `"review"` says what happens next: the decision is in force once a code owner approves and the pull request merges.
- The refusal under `true` names `"review"` and the config line that sets it.
- `true` stays the default, and `false` keeps its meaning.

## Scope
adr's `[policy]` config, the accept write path and its rules, `adr_accept` in the MCP server, `verify`, the README's policy section and the agent skill.

## Consequences
- A person can tell an agent to accept, and the approval that counts is one the forge records and checks.
- The human gate moves from the write to the merge, so it only holds where branch protection requires code owner review; `verify` warns where nothing requires it.
- No approval is recorded on an agent's word.
