# List what a pull brought in log order

## Summary
`adr list --since` and `issues list --since` (run by the post-merge hooks) print a subject's new event types in path order. Two events written in the same second share a timestamp, so their random id part decides the order, and `[new: accepted, proposed]` can come out for a decision proposed and then accepted.

## Steps to reproduce
1. Run `packages/adr/src/cli/hooks.test.ts` "verifies pushes with and without an upstream, and lists what a pull brought" a few times, ideally on a fast machine (GitHub's `ubuntu-24.04-arm` runner).
2. It proposes and accepts a decision in the same second, pulls, and reads the post-merge output.

## Expected
`[new: proposed, accepted]`: the types in the order the fold applies them, `(at, id)` as `compareEvents` sorts.

## Actual
On the arm runner in PR #56 the test failed once with `[new: accepted, proposed]`; the rerun passed. `changedSince` in `packages/adr/src/log.ts` and `packages/issues/src/log.ts` sorts `since.events` by path (`<stamp>-<rand>-<type>.yaml`), and `sinceText` keeps that order.

## Done when
- `since.events` and the `[new: ...]` text list events in log order (`compareEvents`) in adr and issues, through one ledger helper.
- A test writes two events with the same timestamp whose random parts sort against their log order and checks both outputs.
- The PR that does this closes the issue in the same change, with a reason saying how each condition was met.
