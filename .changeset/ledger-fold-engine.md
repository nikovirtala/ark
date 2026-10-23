---
"@nikovirtala/ledger": minor
---

Add the domain-free half of a kind: `defineKind` with the state machine as data, the fold engine (`foldLog`, `projectLog`), numbering on first-parent main (`numberLog`), fold-aware verify checks (transitions, invariants, relations, template lint), atomic log writes (`writeEvents`, `writeNewFile`, `overlayTree`), surfaces (`openToolLog`, `resolveActor`, `resolveSubjectInput`, `renderStateHeader`), the `@nikovirtala/ledger/cli` entry (`runCli`, `verifyCommand`), and testing generators (`exampleMachineKind`, `arbLegalHistory`, `arbSemanticTamper`). Plain `KindSchema` kinds keep their step 2 checks.

Behaviour change: `Git.commit` now writes `trailers` as a literal final paragraph of the message instead of passing them to `git commit --trailer`, so repeated keys and their order survive any `trailer.*` config. Don't put a trailer block of your own in `message`.
