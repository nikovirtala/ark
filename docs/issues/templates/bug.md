---
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
  - id: done
    heading: Done when
    required: true
    guidance: Observable conditions that make this issue finished.
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
