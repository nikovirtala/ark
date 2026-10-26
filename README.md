# ark

ark is a monorepo of tools that keep a project's knowledge in its git repository, usable the same way by humans and agents. adr and issues are built on ledger, a shared core for git-backed, event-sourced records. See the [design doc](docs/00-ark-v1.md).

| Package | Path | Status |
|---|---|---|
| `@nikovirtala/ledger` | [packages/ledger](packages/ledger) | Published at 0.x; internal, API unstable |
| `@nikovirtala/adr` | [packages/adr](packages/adr) | Published at 0.x |
| `@nikovirtala/issues` | [packages/issues](packages/issues) | Issue tracking CLI and library; published from 0.1.0 |

## Development

Install the toolchain with `mise install`, or use Node 24 with corepack enabled. Then:

```sh
pnpm install
pnpm check   # lint, build (tsc -b + tsdown), test
```

ark checks its own commits with its own tools. After `pnpm build`, install the git hooks:

```sh
pnpm git-hooks install     # adr's four hooks, and commitlint on commit-msg
pnpm git-hooks uninstall   # removes both again
```

The hooks run adr from the work tree's build (`packages/adr/dist`), so rebuild after pulling; a broken build blocks commits until you rebuild or commit with `--no-verify`. CI runs the same checks either way. If a hook says a tool "is registered … but not installed", run `pnpm install && pnpm build`, or `pnpm git-hooks uninstall`.

Releases: see [RELEASING.md](RELEASING.md).
