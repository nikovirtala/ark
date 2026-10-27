# Drop empty optional sections from issue descriptions

## Problem
An optional template section left unfilled stays in the description as its heading followed by two blank lines, and nothing can remove it (rough edge 8 of PR #22). `pcmzc2dz` and `6930v8w9` in ark's own log have an empty `## Alternatives` heading, which `issues show` prints right before `## Done when` with two blank lines between them.

Empty text doesn't help: `issues edit <id> --section notes=` on a `task` issue empties the section but keeps the `## Notes` heading and a blank line, so neither `new` nor `edit` can drop a section.

## Proposal
`issues new` leaves out an optional section that has no content, and `issues edit --section <id>=` with empty text removes an optional section, while `issues edit --section <id>=<text>` adds it back in the template's order. `verify` accepts a description without an optional section and still reports a missing required one.

## Alternatives
Keep the empty heading as a prompt to fill it in later. Readers then can't tell "nothing to say" from "not written yet", and `show` prints the empty heading in every view.

## Done when
- `issues new` without content for an optional section writes no heading for it, with a test for each built-in template that has one (`task`'s Notes, `feature`'s Alternatives).
- `issues edit --section <id>=` removes an optional section and `issues edit --section <id>=<text>` adds it back in the template's order, with tests; an empty required section is still refused.
- `issues verify` accepts a description without an optional section and still reports a missing required one, with tests.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
