# Let init start from your own template

## Problem
`adr init --template nygard` writes and stages the nygard starter. Kiro then wrote its own template and had to remove the starter by hand, and init never said which template the config uses.

## Proposal
Let `init --template` take a path to a template file as well as a built-in name, and have init say which templates it wrote and which one is the default.

## Done when
- `adr init --template <path>` and `issues init --template <path>` copy that file into the log's templates and make it the default.
- init's output lists the templates it wrote and names the default one, and says how to change it.
- The README's init example shows starting from your own template.
