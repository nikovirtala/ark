# Help people choose a decision template

## Problem
Kiro read `nygard` (no alternatives section) and `madr` (context first) and wrote its own template to put the decision first, without noticing that `y-statement` leads with the decision. Nothing compares the built-ins where someone picks one.

## Proposal
Describe each built-in where a template is chosen, and show how to write your own.

## Done when
- `adr templates` prints each template's sections in order and a one-line description of what it suits; `adr_list_templates` returns the same.
- `adr init --help` and `adr new --help` name the built-ins and point to `adr templates`.
- The README has a short section on choosing a template: a table of the built-ins, their section order and what each suits, and a worked custom template with its front matter.
