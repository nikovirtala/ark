# Share qualified-reference checks in ledger

## Goal
Move the part of the relation code that adr and issues share into ledger: checking a local or `<source>:<id>` reference against the log and the cached sources. The supersession chain and the issue graph stay in the tools.

## Notes
Candidate 8a of ?29's comparison, recommended "lift later": pick this up with the next change to either tool's `relate`, `planLink` or `resolveTarget`, or when a third kind reads qualified references. What the lift buys is one place that decides unknown, uncached and missing, so the tools can't drift on them; they haven't drifted yet. The shared logic is about 10 lines per call site, and the call sites check in different orders, so each would map the result back to its own messages; until a change touches them, that costs about what it saves. 8b, the chain and the graph, stays in the tools: adr follows one pointer that a state transition sets, while issues has many-to-many graphs with cycles through duplicates. Their shapes don't match.

- adr's `relate` (`packages/adr/src/kind/rules.ts:64-109`, inner `foreign` and `missing`) and `planLink`'s qualified target (`packages/adr/src/write.ts:1153-1179`). issues' `relate` (`packages/issues/src/kind/rules.ts:171-259`) and `resolveTarget` (`packages/issues/src/log.ts:400`).
- All of them split at the first `:` by hand instead of using ledger's `parseQualifiedId`. All of them handle an unknown source, an uncached source (not checked) and an id the cached source doesn't hold. The message `unknown source X; add a [[sources]] entry named X` is the same in both tools.
- The link planners check in different orders. `planLink` refuses a bad source name or a bad id part first (`invalid decision "<input>"`, `write.ts:1157-1159`), then an unknown source (`:1160-1162`), then the kind. `resolveTarget` checks the kind and the unknown source first, and a bad id part last (`use the id in X; numbers in other logs need their history`, `log.ts:417, 435`, pinned by `issues/src/log.test.ts:134`). So `unknown:12` is `invalid decision` in adr and `unknown source unknown` in issues, and both must stay so.
- Keep these differences in the tools: rule ids and messages, the check order above, issues' target-kind rule and `implements-unaccepted`, and how a local target without folded state counts (missing in issues, present in adr).
- `AdrSource`/`ForeignDecision` (exported from `@nikovirtala/adr/kind`) and issues' `SourceLog`/`ForeignSubject` describe the same maps but differ in fields (`ForeignDecision.status` is `DecisionStatus` and has no `effective`; `AdrSource` has no `kind` or `local`). `checkReference` is generic over the tool's own source shape, so all four types stay as they are and no public type of `@nikovirtala/adr/kind` changes. The tools already build these maps (`adr/src/sources.ts:67`, `issues/src/sources.ts:186`), so this lift doesn't need the log-read lift.
- Proposed API, in `packages/ledger/src/sources/`:
  ```ts
  interface SourceEntry<V> { readonly subjects: ReadonlyMap<string, V> | null }
  type Qualified = { readonly source: string; readonly id: string; readonly idValid: boolean };
  type ReferenceCheck<V, T extends SourceEntry<V>> =
    | { readonly result: "local-missing" }
    | { readonly result: "local-unfolded" }
    | { readonly result: "found-local" }
    | ({ readonly result: "malformed-source" } & Qualified)
    | ({ readonly result: "unknown-source" } & Qualified)
    | ({ readonly result: "unchecked"; readonly log: T | null } & Qualified)
    | ({ readonly result: "not-in-source"; readonly log: T } & Qualified)
    | ({ readonly result: "found"; readonly log: T; readonly subject: V } & Qualified);
  checkReference<V, T extends SourceEntry<V>>(ref: string, {
    local: { has(id: string): boolean; folded(id: string): boolean },
    sources: ReadonlyMap<string, T> | null,
  }): ReferenceCheck<V, T>
  ```
- Order: a reference without `:` gives `local-missing`, `local-unfolded` or `found-local`. A reference with `:` is split at the first `:`, as both tools do now. Then, in this order: `sources === null` gives `unchecked` with a `null` log, before the source name is checked, because both `relate`s return before splitting when sources aren't loaded (adr `rules.ts:70`, issues `rules.ts:197`) and `null` is adr's default for reads; otherwise a source part that `isSourceName` (?12) rejects gives `malformed-source`; a name not in `sources` gives `unknown-source`; an uncached source gives `unchecked` with its log; then `found` with the subject, or `not-in-source`. Every qualified result carries `idValid` (`isSubjectId` of the id part, from `identity/`, layer 2) rather than taking a place in that order, because the planners check the id at different points.
- How each call site maps it, so no message changes:
  - adr `relate`: `malformed-source` and `unknown-source` → `decision/unknown-source` (so, with sources loaded, a stored reference whose source name is over 32 characters, which `REF` allows, keeps today's finding; with `sources === null` it is `unchecked` and still skipped); `unchecked` → skip; `not-in-source` and `local-missing` → `decision/reference-missing`; `local-unfolded` counts as present.
  - adr `planLink`: `malformed-source` or `idValid === false` → `invalid decision …`, before anything else; then `unknown-source`, the kind check on `log`, `not-in-source` and the uncached note, as now. adr builds the `sources` map from `o.sources` and `o.logs`, with `subjects: null` for a configured but uncached source, and each entry carries its kind from `o.kinds` (`write.ts:1163`), which the kind check reads, so uncached sources keep the kind check.
  - issues `relate`: `malformed-source` and `unknown-source` → `issue/unknown-source` (with its `adr` wording); the `log.kind` check for `issue/target-kind` before skipping `unchecked` or reporting `not-in-source`, in today's order; `found`'s subject for `issue/implements-unaccepted`; `local-unfolded` → missing.
  - issues `resolveTarget`: its whole-string `malformed(s)` check (empty, over 64 characters, or a control character) stays first, then the `adr:` local-decision case (`source === "adr"`) and the kind checks; then `malformed-source` and `unknown-source` → `unknown source …`, and under `implements` a `log` with `local: true` → `unknown source …` too (`log.ts:411`); then `idValid === false` → `use the id in …`. `resolveTarget` never reads `subjects`, so `unchecked`, `not-in-source` and `found` are all accepted after these checks. It passes an empty map where `sources` is `null`, as it does now.
- ledger already has two readers of `<source>:<id>`, and neither tool calls either. `parseQualifiedId` (`sources/qualified-id.ts`) parses strictly, with the 32-character cap and an 8-character id, and returns `null` for anything else, so it can't classify adr's long `REF` source names or the bad id parts both planners report. `resolveQualifiedId` (`sources/resolve.ts`) checks a reference asynchronously against raw trees (an events directory or body file exists) and returns `malformed`, `unknown-source`, `not-found` or `ok`, while both `relate`s work on folded subject maps and need the uncached and unfolded cases. Both are root exports, so they stay. Say in the README when to use each of the three, and decide in this issue whether `resolveQualifiedId` can be rebuilt on `checkReference`.
- The log-read lift edits other functions of `adr/src/sources.ts`, `issues/src/sources.ts` and `issues/src/log.ts`, and the write-path lift rewrites most of `packages/adr/src/write.ts`, where this lift changes `planLink` (around lines 1114-1179). Whichever lands second rebases.
- Document the new exports in `packages/ledger/README.md`.

## Done when
- ledger exports `checkReference` and its `ReferenceCheck` result type, with a unit test for each result variant, for `idValid` false on each qualified variant, for a source name over 32 characters, and for a malformed source name with `sources === null` giving `unchecked`; its README says when to use `checkReference`, `parseQualifiedId` and `resolveQualifiedId`.
- adr's and issues' `relate`, adr's `planLink` and issues' `resolveTarget` use it, and none of them splits `<source>:<id>` or checks its source name or id part itself.
- Both tools' findings and link messages are unchanged: their existing tests, `kind/rules.test.ts` and `issues/src/log.test.ts` included, pass with no change to what they assert.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
