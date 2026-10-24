# Keep each tool's kind apart from its CLI and MCP code

## Context
Any ledger-based tool can fold another tool's log by importing that tool's kind, and issues does so to check that an `implements` link points at an accepted decision ([Reading another kind's log](../../00-ark-v1.md#ledger-the-shared-event-envelope)). If a kind came from a tool's full package, importing it would also load the tool's CLI and, from phase 3, its MCP server. The ark design settled where kinds are exported from and that surfaces live in their own entries ([Open questions](../../00-ark-v1.md#open-questions), [Implementation notes and roadmap](../../00-ark-v1.md#implementation-notes-and-roadmap)), but no decision records this layout or what enforces it.

## Decision
Every ledger-based tool exports its kind from a `kind` subpath, `@nikovirtala/<tool>/kind` (`src/kind.ts`), which imports only ledger's root entry and the tool's own kind modules, never CLI or MCP code. The tool's root entry is its library, and its CLI is the binary built from `src/cli.ts` ([adr: Implementation notes and roadmap](../../01-adr-v1.md#implementation-notes-and-roadmap)).

ledger's root entry, `@nikovirtala/ledger`, holds every layer without CLI, MCP or test code, including the Surfaces helpers that tools call from their libraries: `openToolLog`, `resolveActor`, `resolveAttribution`, `renderStateHeader` and the commit-message templates. The CLI scaffolding is `@nikovirtala/ledger/cli`, the test harness is `@nikovirtala/ledger/testing`, and the MCP scaffolding will be `@nikovirtala/ledger/mcp`. The root entry imports none of these entries, and none of them imports another. Each export path has its own bundle entry in the package's `tsdown.config.ts`.

`packages/ledger/src/layers.test.ts` enforces ledger's side (layer order, and imports between the entries). `packages/adr/src/kind-isolation.test.ts` imports the built `@nikovirtala/adr/kind` and fails if that loads adr's or ledger's CLI code.

## Scope
The entry points of every ledger-based package and the import boundaries between them: the `exports` in each `package.json` and the bundle entries in each `tsdown.config.ts`, ledger's root entry and its `cli` and `testing` entries, each tool's `src/kind.ts`, and the tests that enforce the boundaries. artifact is not built on ledger and is out of scope.

## Consequences
- issues, and any later tool, can fold another tool's log by importing its kind without loading that tool's CLI or MCP code.
- Code a kind needs can't live in a tool's CLI modules; it goes into the kind modules or ledger's root entry.
- A new entry, such as `@nikovirtala/ledger/mcp` in phase 3, needs an export path, a bundle entry and a place in the layer test.
- This refines ADR-0001's one package per tool and ADR-0002's shared core without changing them.
