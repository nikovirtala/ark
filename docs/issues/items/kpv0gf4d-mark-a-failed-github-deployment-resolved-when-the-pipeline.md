# Mark a failed GitHub deployment resolved when the pipeline is unfrozen

## Goal
A failed run stays `failure` on GitHub after its rollback and the unfreeze, so anything reading GitHub Deployments (draft's map) can't tell a failure someone still has to handle from one already handled. Make GitHub say when it is handled.

## Notes
- Today `GitHubProvenance.finish` marks earlier successes inactive on a success and leaves failures as they are on purpose (packages/deployment/src/provenance.ts, provenance.test.ts). Keep the failure in the status history: post a new status, don't rewrite one.
- Proposal: `deploy unfreeze` posts an `inactive` status on the newest failed deployment of the environment with a description such as "Failed, handled: unfrozen <date>; running <last good commit>". The status history still shows the failure first.
- Alternative to weigh: a later success marking earlier failures inactive too ("Superseded by <sha>"), which needs no unfreeze hook but leaves a frozen-then-unfrozen pipeline with no later deploy still showing `failure`.
- Found through draft's map, where kiro-remote's failing-smoke-check drill shows as waiting on Niko (draft issue: Fix what the map's first real use showed).
- `unfreeze` is a person's command (agents are refused), so the status is posted with the pipeline's provenance token as `finish` does; check the unfreeze path has it, or post from the next run instead.

## Done when
- After an unfreeze, the newest failed deployment of the environment has an `inactive` status whose description says it was handled, and its `failure` status is still in the history; tested with MemoryGitHub.
- The README's Provenance section says so.
