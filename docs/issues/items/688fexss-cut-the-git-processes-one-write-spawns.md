# Cut the git processes one write spawns

## Goal
Make one ledger read or write spawn far fewer git processes, by resolving what does not change within one operation once.

## Notes
- One `comment` write with its checks in `packages/issues/src/write.index.test.ts` (`-t "comment × 1"`) spawned 428 git processes at e5fe532: 218 `rev-parse`, 40 `hash-object`, 28 `cat-file --batch`, 22 `ls-tree`, 22 `log`, 21 `symbolic-ref`.
- The main-ref probe in `resolveMainRef` (`packages/ledger/src/fold/numbering.ts`) and `isShallow` ran 21 times each; `HEAD^{commit}` resolved 52 times; `cat-file --batch` started a new process 28 times instead of reusing one.
- A spawn costs about 2ms from node on an idle machine and more under a parallel test run. The suites spawn about 214,000 git processes.
- Any cache must end when the operation changes HEAD, a ref or the index, and must not leak between operations.

## Done when
- The same `comment × 1` test spawns at most half as many git processes, counted the same way.
- The adr and issues suites pass with no test changed to accommodate a cache.
- The PR closes this issue with the spawn counts and suite times before and after.
