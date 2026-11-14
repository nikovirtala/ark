# Support every Node.js release line in LTS

## Problem
The packages require Node 24, and on Node 22 npm prints only an `EBADENGINE` warning: Kiro could not tell what would fail. The decision to support every LTS line (adr:xske65j7) needs implementing.

## Proposal
Lower `engines` and the bundle targets to the oldest LTS line (22), run the tests on 22, 24 and 26 in CI, build releases on 22, and check the running Node version when a CLI or MCP server starts.

## Done when
- `engines` is `>=22` in the workspace and every package, and the bundles target `node22`.
- CI runs the tests on Node 22, 24 and 26; the release workflow builds on 22.
- On an unsupported Node, `adr`, `issues` and their MCP servers stop before doing anything, with a message such as: "adr needs Node.js 22 or newer, a release line in LTS (22, 24, 26); this is Node.js 20.11.0."
- The ledger, adr and issues READMEs list the supported lines under their requirements, say that the floor follows Node's LTS schedule, and link the schedule.
- adr:xske65j7 is accepted, and ADR-0009 is superseded.
