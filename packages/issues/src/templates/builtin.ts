/**
 * The built-in issue templates, version 1 (02 Templates and customization). `issues init` and
 * `issues new --template <name>` copy the one they use into `<root>/templates/<name>.md`, so the
 * team owns it and its versions live in git. Every section is required unless marked optional,
 * and each template has a required `done` section ("Done when"), which template lint demands.
 */

const DONE = `  - id: done
    heading: Done when
    required: true
    guidance: Observable conditions that make this issue finished.`;

const BUG = `---
template: bug
version: 1
sections:
  - id: summary
    heading: Summary
    required: true
    guidance: One or two sentences on what is wrong, for whom.
  - id: reproduce
    heading: Steps to reproduce
    required: true
    guidance: Numbered steps from a clean state. Include versions.
  - id: expected
    heading: Expected
    required: true
    guidance: What should have happened.
  - id: actual
    heading: Actual
    required: true
    guidance: What happened instead. Paste errors as code blocks.
${DONE}
---
# {{title}}

## Summary
{{summary}}

## Steps to reproduce
{{reproduce}}

## Expected
{{expected}}

## Actual
{{actual}}

## Done when
{{done}}
`;

const FEATURE = `---
template: feature
version: 1
sections:
  - id: problem
    heading: Problem
    required: true
    guidance: Who needs what, and why it matters now.
  - id: proposal
    heading: Proposal
    required: true
    guidance: What to build, from the user's side.
  - id: alternatives
    heading: Alternatives
    required: false
    guidance: Other ways to solve the problem, and why not them.
${DONE}
---
# {{title}}

## Problem
{{problem}}

## Proposal
{{proposal}}

## Alternatives
{{alternatives}}

## Done when
{{done}}
`;

const TASK = `---
template: task
version: 1
sections:
  - id: goal
    heading: Goal
    required: true
    guidance: What this task changes, in a sentence or two.
  - id: notes
    heading: Notes
    required: false
    guidance: Context, links and anything the person doing it should know.
${DONE}
---
# {{title}}

## Goal
{{goal}}

## Notes
{{notes}}

## Done when
{{done}}
`;

/** The built-in templates by name: the file text `issues init` and `issues new` materialize. */
export const BUILTIN_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  bug: BUG,
  feature: FEATURE,
  task: TASK,
});

/** The text of the built-in `task` template, version 1: the default template. */
export const TASK_V1: string = TASK;

/** The text of a built-in template, or `null` for an unknown name. */
export function builtinTemplate(name: string): string | null {
  return Object.hasOwn(BUILTIN_TEMPLATES, name) ? (BUILTIN_TEMPLATES[name] ?? null) : null;
}
