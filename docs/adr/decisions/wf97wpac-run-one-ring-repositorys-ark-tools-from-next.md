# Run one ring repository's ark tools from next

## Context
Under va08e4c3, ark publishes to `next`, promotes to `latest`, and every repository other than ark runs its tools from `latest`. Only a scripted canary uses `next`, so between three canary runs and every agent everywhere no real work uses a release. The 27 November 2026 review of the factory design (docs/reviews/2026-11-27-factory-v1.md) set this against Kiro's factory, which gathers evidence in an internal edge build of unmerged changes before giving any kind of change more autonomy. The revised design (docs/05-factory-v1.md, Release channels and promotion) adds a ring of real use to the bake.

kiro-remote's own repository fits: its work runs in Kiro cloud sessions whose transcripts the intake already harvests, so a papercut there becomes a report without the deferred local-session hook, and each fresh sandbox resolves the channel at start.

## Decision
We will run one consuming repository's ark tools from `next`, as a ring of real use before `latest`.

- **One ring.** The ring is one repository, named in the factory configuration (`factory.toml`); it starts as kiro-remote. Its MCP configuration runs `npx -y --prefer-online @nikovirtala/<tool>@next mcp`. Every other repository keeps running `latest` as va08e4c3 decides.
- **The ring blocks, it does not wait.** Promotion to `latest` requires no reproducible report from the ring against the new version. It does not wait for a minimum number of ring calls, so the time to `latest` is unchanged.

Open question: whether `init --setup` writes the ring's `@next` entries itself from the factory configuration, or the ring's configuration is kept by hand. Until that is settled, the ring's entries are kept by hand.

## Scope
The MCP configuration of the ring repository (kiro-remote's repository first), the ring setting in the factory configuration, and the promotion gate's ring condition. It narrows va08e4c3's "consumers run `latest`" for that one repository and changes nothing else of it. It does not change how ark pins its own tooling (ADR-0017).

## Consequences
Easier: real cloud sessions use a release before every agent does, so a regression the canary cannot see has a chance to show up as a report while only one repository runs it. The evidence needed before giving any kind of change more autonomy starts to build.

Harder: kiro-remote's sessions run unpromoted releases, so its own work meets regressions first, while every other repository waits for the gate. Two channels are in real use, so reports must record the version and channel that ran.

Risk: a ring with little ark use catches little; a bake that often ends with no ring calls is a sign to choose a busier ring or add a minimum, which reopens this decision.
