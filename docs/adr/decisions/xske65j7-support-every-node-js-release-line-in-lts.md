# Support every Node.js release line in LTS

## Context
ADR-0009 made Node 24 the minimum so that ark has one toolchain and no version matrix. ark's tools are meant to be added to any repository, and many teams run whatever Node.js line is in LTS: in November 2026 that is 22 (maintenance until 2027-04-30), 24 (maintenance until 2028-04-30) and 26 (active LTS) ([Node.js release schedule](https://github.com/nodejs/Release)).

Feedback from Kiro, working on Node 22, found only npm's `EBADENGINE` warning and no answer to what would fail. Nothing does, as far as we know: the packages import only long-standing Node modules (`fs`, `path`, `child_process`, `crypto`, `util`, `url`, `os`), a search found none of the APIs added in Node 24, and the published adr and issues ran `verify` against ark's own logs on Node 22.23 without findings. What one version saved was the CI matrix, which is a few jobs.

## Decision
Every ark package supports each Node.js release line in active or maintenance LTS.

- `engines` names the oldest such line (`>=22` today), and the bundles target it.
- CI runs the tests on every supported line; the release builds on the oldest.
- `mise.toml` may use any supported line for development.
- When a line reaches end of life, the next release raises the floor as a breaking change, and its changeset names the line dropped.
- The CLIs and MCP servers check the running Node version at start and stop with a message that names the supported lines, instead of failing somewhere later.
- The ledger, adr and issues READMEs state this policy and the current floor where the requirements are listed.

## Scope
The supported runtime of every ark package: the `engines` fields, the bundle targets, `mise.toml`, the Node versions in the CI and release workflows, the version check at startup, and the requirements in the READMEs.

## Consequences
- Teams on any LTS line can use the tools; Node 22 users stop getting a warning with no explanation.
- CI runs the tests once per supported line.
- Code can't use an API newer than the floor until the floor rises; the dates it rises on are known in advance from the Node.js schedule.
- A line's end of life forces a breaking release, so the floor never lags behind what Node.js itself supports.
