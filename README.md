# ark

ark keeps decisions and issues as event logs in git, like a wiki or issue tracker but versioned with your code.

[![CI](https://img.shields.io/github/actions/workflow/status/nikovirtala/ark/ci.yml?branch=main&label=CI)](https://github.com/nikovirtala/ark/actions/workflows/ci.yml)
[![@nikovirtala/adr on npm](https://img.shields.io/npm/v/@nikovirtala/adr?label=%40nikovirtala%2Fadr)](https://www.npmjs.com/package/@nikovirtala/adr)
[![@nikovirtala/issues on npm](https://img.shields.io/npm/v/@nikovirtala/issues?label=%40nikovirtala%2Fissues)](https://www.npmjs.com/package/@nikovirtala/issues)
[![Node 24+](https://img.shields.io/node/v/@nikovirtala/adr)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Documentation](#documentation) · [Install](#install) · [Quick start](#quick-start) · [Contributing](#contributing) · [Changelog](#status-and-compatibility)

ark records a project's architecture decisions and its work in the same git repository as the code, as append-only event logs that humans and coding agents read and write the same way. [adr](packages/adr) tracks architecture decision records, [issues](packages/issues) tracks work, and both build on [ledger](packages/ledger), a shared core for git-backed, event-sourced records. For the design and rationale, read the [ark design doc](docs/00-ark-v1.md).

Each tool ships as its own npm package with its own CLI and MCP server, so you install `adr` or `issues`, not a single combined tool.

## Install

ark tools need Node 24 or newer and git 2.32.0 or newer. Install the tool you want as a dev dependency:

```sh
npm install --save-dev @nikovirtala/adr
```

```sh
npm install --save-dev @nikovirtala/issues
```

Installing `issues` installs `adr` too, because issues reads the decision log to check `implements` links. You can also run either tool without installing it, with `npx @nikovirtala/adr --help` or `npx @nikovirtala/issues --help`.

## Quick start

Record your first architecture decision. Run these commands at the root of a git repository. The `--section` flags fill the `nygard` template's required sections, so the example needs no editor.

```sh
npx @nikovirtala/adr init --commit
npx @nikovirtala/adr new "Use Aurora for orders" --section context="We need SQL." --section decision="Use Aurora for the orders service." --section scope="services/orders" --section consequences="We run a managed database." --commit
npx @nikovirtala/adr list
```

`adr init` writes `docs/adr/adr.toml` and a starter template. `adr new` proposes the decision and stages its files. `adr list` prints the log with each decision's computed status (the `67svw9m5` id is generated, so yours differs):

```text
-  67svw9m5  proposed  Use Aurora for orders
```

A proposed decision shows its id until a human accepts it with `npx @nikovirtala/adr accept 67svw9m5 --commit`, which assigns the number `ADR-0001`. To go further, read the [adr README](packages/adr) for every command, or the [issues README](packages/issues) to track work the same way.

## Why ark

Architecture decisions and issues are knowledge about the code, so ark keeps them next to the code, in the same git history, rather than in a separate tool. State such as a decision's status or an issue's blockers is folded from an append-only event log, so the history is auditable and branches merge without conflicts. The same CLI, library and MCP server serve people and coding agents, so an agent that opens an issue or proposes a decision leaves the same trail you do.

## When not to use it

ark fits teams that live in git and want their decisions and work versioned with the code. Look elsewhere if you:

- want a hosted issue tracker with a graphical web UI and dashboards.
- work outside git, since ark stores every record as git-tracked files.
- want one combined command for everything, which ark deliberately does not provide: you install and run `adr` or `issues` separately.

## Status and compatibility

ark is released at 0.x and its packages are versioned independently:

- `@nikovirtala/ledger`: the shared core, published at 0.x, internal to ark with an unstable API until 1.0.
- `@nikovirtala/adr`: published at 0.x.
- `@nikovirtala/issues`: published at 0.x.

Every tool needs Node 24 or newer (`engines: >=24`) and git 2.32.0 or newer. Older Node prints npm's `EBADENGINE` warning and is not supported.

Packages are versioned and their changelogs are written with [Changesets](https://github.com/changesets/changesets); there is no root changelog. Read [RELEASING.md](RELEASING.md) for the release flow, and each package's `CHANGELOG.md` for its history.

## Documentation

- [adr README](packages/adr): the CLI, library and MCP server for architecture decision records.
- [issues README](packages/issues): the CLI, library and MCP server for issue tracking.
- [ledger README](packages/ledger): the shared, git-backed, event-sourced core that adr and issues build on.
- [ark design doc](docs/00-ark-v1.md): what ark is, why it exists, and how the monorepo fits together.
- [adr design doc](docs/01-adr-v1.md): the decision kind, its states and its rules.
- [issues design doc](docs/02-issues-v1.md): the issue kind, its states, relations and rules.
- [setup design doc](docs/03-setup-v1.md): how a repository sets up ark's tools, hooks and config.
- [AGENTS.md](AGENTS.md): the conventions coding agents follow in this repository.
- [RELEASING.md](RELEASING.md): the Changesets release and npm publishing flow.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to set up, build, test and submit a change.
- [SECURITY.md](SECURITY.md): how to report a security issue.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): the behavior expected of everyone in this project.

## Getting help

Ask a question or report a bug in the repository's [GitHub issues](https://github.com/nikovirtala/ark/issues). ark tracks its own work in its issue log under [docs/issues](docs/issues); list the open work with `npx @nikovirtala/issues list`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up, build and test ark, and [AGENTS.md](AGENTS.md) for the repository's conventions, which coding agents follow too.

## License

ark is licensed under the MIT License (SPDX identifier `MIT`), copyright Niko Virtala. See [LICENSE](LICENSE).
