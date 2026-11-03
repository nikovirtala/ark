# Contributing to ark

Thanks for helping improve ark. This guide covers how to set up the repository, propose work, and submit a change. For the authoritative command and convention reference, read [AGENTS.md](AGENTS.md); coding agents follow it too. This guide points you there rather than repeating it.

## Set up your environment

You need Node 24 or newer and git 2.32.0 or newer. Clone the repository, then install dependencies and run the full check:

```sh
git clone https://github.com/nikovirtala/ark.git
cd ark
pnpm install
pnpm check
```

`pnpm check` runs `pnpm lint`, `pnpm build`, and `pnpm test` together. Run the steps on their own while you iterate:

```sh
pnpm lint
pnpm build
pnpm test
```

The repository pins its toolchain with [mise](https://mise.jdx.dev/), so `mise install` gives you the expected Node and pnpm versions. If you manage Node yourself, use Node 24 and let [corepack](https://nodejs.org/api/corepack.html) activate the pinned pnpm from `package.json`.

## Understand a change

The unit of work you ship is a **change**: one coherent piece of behavior. A pull request is the review-and-merge mechanism a change goes through, not the work itself. A change can ship in one pull request or several. Describe your work in terms of changes.

## Propose work

ark tracks its own work with the `issues` tool in [docs/issues](docs/issues), and its own decisions with the `adr` tool in [docs/adr](docs/adr). Browse the open work there before you start, so you build on what exists.

- Ask a question or report a bug in [GitHub issues](https://github.com/nikovirtala/ark/issues).
- List ark's tracked work with `node packages/issues/dist/cli.js list` after `pnpm build`.
- A pure documentation change needs no new ADR. Propose an ADR only when you change architecture, data stores, dependencies, or cross-cutting conventions.

Coding agents read [.claude/skills/adr/SKILL.md](.claude/skills/adr/SKILL.md) and [.claude/skills/issues/SKILL.md](.claude/skills/issues/SKILL.md) before they record decisions or issues. Follow those skills when you work as an agent.

## Write commits

Keep history linear, and keep each commit atomic: one logical change that builds and passes tests on its own. Write subjects as [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

- Use a type such as `feat`, `fix`, or `docs`. Use `docs:` for documentation, including community-health files and README changes.
- Write the description in the imperative mood, start it with a lowercase letter, drop the trailing period, and keep it to 72 characters or fewer.
- Amend an earlier commit with `git commit --fixup=<sha>` rather than piling on "address review" commits.

## Submit a change

Open a **draft** pull request against `main` as soon as your branch has its first commit. Keep its description current: what the change does, why, what remains, and how you tested it.

Before you mark the pull request ready for review, squash your `fixup!` commits, rebase onto the latest `origin/main`, and verify every commit. See [AGENTS.md](AGENTS.md) for the per-commit check and the full ready-for-review flow.

Documentation is part of the definition of done. Update the docs your change affects, and tick the documentation item in the pull request template before you request review.

## Release a change

Releases use [Changesets](https://github.com/changesets/changesets). When a change should be released, run `pnpm changeset`, pick the packages and bump types, and commit the generated file. Read [RELEASING.md](RELEASING.md) for the full release and publishing flow.
