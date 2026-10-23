# @nikovirtala/ledger

## 0.3.0

### Minor Changes

- b241ce5: Add the domain-free half of a kind: `defineKind` with the state machine as data, the fold engine (`foldLog`, `projectLog`), numbering on first-parent main (`numberLog`), fold-aware verify checks (transitions, invariants, relations, template lint), atomic log writes (`writeEvents`, `writeNewFile`, `overlayTree`), surfaces (`openToolLog`, `resolveActor`, `resolveSubjectInput`, `renderStateHeader`), the `@nikovirtala/ledger/cli` entry (`runCli`, `verifyCommand`), and testing generators (`exampleMachineKind`, `arbLegalHistory`, `arbSemanticTamper`). Plain `KindSchema` kinds keep their step 2 checks.
  
  Behaviour change: `Git.commit` now writes `trailers` as a literal final paragraph of the message instead of passing them to `git commit --trailer`, so repeated keys and their order survive any `trailer.*` config. Don't put a trailer block of your own in `message`.

## 0.2.0

### Minor Changes

- 51f134c: Add the mechanical core: git access, subject and event identity, the `ledger/v1` envelope and its JSON Schema, log snapshots, mechanical verify checks with text, JSON and GitHub output, `[[sources]]`, section-schema templates, the shared git hook shim, and the `@nikovirtala/ledger/testing` harness. The API is internal and unstable until 1.0.

## 0.1.0

### Minor Changes

- 34e5d6e: First release: the `ENVELOPE_VERSION` constant and an empty `@nikovirtala/ledger/testing` entry. Published to prove the release pipeline; the API is internal and unstable.
