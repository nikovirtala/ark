# ark

ark is a monorepo of tools that keep a project's knowledge in its git repository, usable the same way by humans and agents. adr and issues are built on ledger, a shared core for git-backed, event-sourced records. See the [design doc](docs/00-ark-v1.md).

| Package | Path | Status |
|---|---|---|
| `@nikovirtala/ledger` | [packages/ledger](packages/ledger) | Published at 0.x; internal, API unstable |
| `@nikovirtala/adr` | [packages/adr](packages/adr) | Private skeleton |
| `@nikovirtala/issues` | [packages/issues](packages/issues) | Private skeleton |

## Development

Install the toolchain with `mise install`, or use Node 24 with corepack enabled. Then:

```sh
pnpm install
pnpm check   # lint, build (tsc -b + tsdown), test
```
