# Find what adr and issues implement the same way

## Goal
Roadmap step 5, "Lift what matches" (`docs/00-ark-v1.md`), moves into ledger whatever adr and issues now implement the same way and deletes the copies. This issue is the investigation that decides what moves: find every mechanism the two tools duplicate, compare the two implementations, and recommend for each whether to lift it and in which order. It changes no code.

## Notes
Candidates known so far:

- **Relations.** adr's supersession chain and `linked` (`packages/adr/src/kind/project.ts`, `views.ts`) against issues' relation graph (`packages/issues/src/kind/graph.ts`: `depends-on`, `part-of`, cycles, the derived `blocks`, `children` and `canonical`). The ark and adr designs name this as the main candidate, and ADR-0002's note says relations start in the tools.
- **The write path.** adr's `planEvent` and `applyPlan` (`packages/adr/src/write.ts`, about 2,400 lines) against issues' plan and apply (`packages/issues/src/plan.ts`, `apply.ts`): the precheck, the commit scope with staged extras, `--only` commits, index refresh and recovery hints. The fix for ?5 ported adr's approach by hand.
- **Index helpers.** `packages/adr/src/log-index.ts` and `packages/issues/src/log-index.ts`; issues PR 2 already moved the copy helpers into ledger.
- **Source helpers.** ?12 covers index numbering and the source-name pattern.
- **Agent surfaces.** Search, the MCP servers and skill writing: check what is still copied after issues 3a to 3d.

Already lifted: set events (adr phase 2a), text search (issues 3a) and git operations.

For each candidate the report gives the files on each side, what is the same, what differs and whether that difference is domain or accidental, a proposed ledger API, the risk, and a rough size in commits. Domain rules stay in the kinds: state machines, invariants, and what supersession or a dependency means.

## Done when
- A comment on this issue lists every candidate with the comparison above and a recommendation: lift now, lift later, or leave in the tools.
- Each candidate recommended for lifting has its own issue, `part-of` this one, with a Done when, and `depends-on` links where one lift needs another. ?12 is one of them or is linked to the one that covers it.
- If the chosen candidates differ from "most likely the relation layer", `docs/00-ark-v1.md` step 5 names them.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
