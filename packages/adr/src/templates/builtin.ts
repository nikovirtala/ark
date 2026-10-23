/**
 * The built-in decision templates, version 1 (design §5.7). `adr new` copies the one it uses into
 * `<root>/templates/<name>.md` on first use, so the team owns it and its versions live in git
 * (D4). Every section is required unless marked optional, and each has a required Scope section
 * (01:311).
 */

const NYGARD = `---
template: nygard
version: 1
sections:
  - id: context
    heading: Context
    required: true
    guidance: What is the issue that motivates this decision? Describe the forces at play.
  - id: decision
    heading: Decision
    required: true
    guidance: What is the change that we're proposing or doing? Write it in the active voice.
  - id: scope
    heading: Scope
    required: true
    guidance: What does this decision govern? Name the systems, code paths or teams it applies to.
  - id: consequences
    heading: Consequences
    required: true
    guidance: What becomes easier or harder because of this change? Include the risks.
---
# {{title}}

## Context
{{context}}

## Decision
{{decision}}

## Scope
{{scope}}

## Consequences
{{consequences}}
`;

const MADR = `---
template: madr
version: 1
sections:
  - id: context
    heading: Context and Problem Statement
    required: true
    guidance: Describe the context and the problem in two or three sentences, or as a question.
  - id: drivers
    heading: Decision Drivers
    required: false
    guidance: List the forces and concerns that shape the decision.
  - id: options
    heading: Considered Options
    required: true
    guidance: List the options that were considered, one per line.
  - id: decision
    heading: Decision Outcome
    required: true
    guidance: Name the chosen option and say why it was chosen.
  - id: scope
    heading: Scope
    required: true
    guidance: What does this decision govern? Name the systems, code paths or teams it applies to.
  - id: consequences
    heading: Consequences
    required: true
    guidance: Describe the good and the bad consequences of the chosen option.
---
# {{title}}

## Context and Problem Statement
{{context}}

## Decision Drivers
{{drivers}}

## Considered Options
{{options}}

## Decision Outcome
{{decision}}

## Scope
{{scope}}

## Consequences
{{consequences}}
`;

const Y_STATEMENT = `---
template: y-statement
version: 1
sections:
  - id: statement
    heading: Statement
    required: true
    guidance: In the context of <use case>, facing <concern>, we decided for <option>, to achieve <quality>, accepting <downside>.
  - id: scope
    heading: Scope
    required: true
    guidance: What does this decision govern? Name the systems, code paths or teams it applies to.
---
# {{title}}

## Statement
{{statement}}

## Scope
{{scope}}
`;

/** The built-in templates by name: the file text `adr new` materializes. */
export const BUILTIN_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  nygard: NYGARD,
  madr: MADR,
  "y-statement": Y_STATEMENT,
});
