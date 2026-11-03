# Architecture

This codemap orients you in the repository. It summarizes the layout and the invariants, then points at the design docs for the full story. It does not duplicate them.

## Monorepo layout

ark is one repository, `nikovirtala/ark`, with one package per tool and a shared core they depend on. Each package is versioned and released on its own.

- `packages/ledger` (`@nikovirtala/ledger`): the shared core. It provides the machinery for git-backed, event-sourced records: git access, ids, the event envelope, folding, verification, sources, scope, templates, hooks, surfaces and a test harness. Published at 0.x and documented as internal until its API settles.
- `packages/adr` (`@nikovirtala/adr`): the decision kind on top of ledger. A decision is a Markdown body plus an append-only event log; its body freezes once accepted.
- `packages/issues` (`@nikovirtala/issues`): the issue kind on top of ledger. An issue keeps a living body plus an event log, and links its work to accepted decisions.
- `docs/`: the design docs (`00`-`03`) plus `adr/` and `issues/`, ark's own logs managed by its own tools.
- `.github/workflows/`: CI and release pipelines.

## Mechanism versus meaning

The core split, summarized from [docs/00-ark-v1.md](docs/00-ark-v1.md): ledger provides the mechanism and a kind defines the meaning.

- ledger decides how an event is stored, ordered, validated and found. It knows subjects, events, kinds, logs and findings, and nothing about decisions or issues.
- A kind decides what an event means: its event types, how events fold into state, which rules must hold, and what a read returns. adr and issues each hand ledger a kind and get back the machinery to fold, verify, index and serve it.
- Every kind shares one event envelope, so any tool can fold any other tool's log with the same engine. issues imports adr's kind to check that its `implements` links point at accepted decisions.

## Key invariants

These hold across every ledger-based tool. See the design docs for how each is enforced.

- Linear history. Merges are fast-forward or rebase only; main is never force-pushed and commits are never squash-merged.
- Append-only event logs. Each subject is a directory of immutable YAML event files; state is never written into a subject file.
- State folded from events on read. Every read replays a subject's events through the kind's state machine, so status is computed, never stored.
- Numbering on main's first-parent history. Display numbers (for example `ADR-0001`) are assigned in the order their numbering event lands on the first-parent history of main, and are never stored or renumbered.
- Commits are atomic. Each commit builds and passes its own checks.

## Where to read next

- [docs/README.md](docs/README.md): the reading order for the design docs and logs.
- [docs/00-ark-v1.md](docs/00-ark-v1.md): ark's overview, rationale, monorepo design and roadmap.
- [docs/01-adr-v1.md](docs/01-adr-v1.md) and [docs/02-issues-v1.md](docs/02-issues-v1.md): the two tools.
- [docs/03-setup-v1.md](docs/03-setup-v1.md): the agent setup design.
- [docs/adr/](docs/adr/): the decision log. List it with `node packages/adr/dist/cli.js list` from the repository root.
