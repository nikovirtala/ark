---
"@nikovirtala/issues": patch
---

A `--commit` that commits an issue's `opened` event now also commits that issue's staged description and template, and the staged events and description of any issue it references that isn't committed yet. Before, `new` without `--commit` followed by, say, `comment --commit` left the description staged, and `issues verify --ref HEAD` reported `body/missing` at that commit. `edit --commit` on an issue opened without `--commit` now takes its staged events too. The commit refuses with exit 2, before writing anything and naming the file, when one of those files has unstaged changes, isn't tracked or is missing. A committed issue's description is still never swept into an event commit.
