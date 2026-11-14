# Let a code owner's approval stand for a human's accept

## Problem
`accept_requires_human` is all or nothing. A person who tells an agent to accept a decision has no path except turning the policy off. Kiro hit this and asked for `--confirm-by <email>`, which would record an approval nobody can check.

## Proposal
Implement adr:yv3sfp9m: a third value, `"review"`, under which an agent writes the accept and a code owner's approval of the pull request is the human's acceptance.

## Done when
- `[policy] accept_requires_human = "review"` lets agents accept, from the CLI and from `adr_accept`, recorded as the agent acting for the person.
- An agent's accept under `"review"` prints that the decision takes effect once a code owner approves the pull request and it merges.
- The refusal under `true` says how to let agents accept: it names `"review"`, the line in `adr.toml`, and what it requires.
- `adr verify` warns when the policy is `"review"` and no `CODEOWNERS` entry covers the decision log, and the warning says why it matters.
- The README's policy section shows the three values side by side: who may accept, where the human acts, and what each needs from the repository.
- The agent skill says what to do when a person asks the agent to accept: under `true`, prepare the decision and ask the person to accept; under `"review"`, accept and say that the pull request needs a code owner's approval.
