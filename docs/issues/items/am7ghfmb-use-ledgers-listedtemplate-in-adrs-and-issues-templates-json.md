# Use ledger's ListedTemplate in adr's and issues' templates JSON types

## Goal
Declare the `templates` field of adr's `TemplatesJson` and issues' `IssueTemplatesJson` as `readonly ListedTemplate[]`, so the shape `listKindTemplates` returns has one declaration and the tools' types follow it.

## Notes
Found in code review v1 of the change for ?44.

- ?44 moved the template listing into ledger as `listKindTemplates`, whose entries are `ListedTemplate` (`packages/ledger/src/templates/list.ts:9`). Both tools now pass its entries straight through (`templates: listed.templates`).
- `TemplatesJson.templates` (`packages/adr/src/templates/list.ts:12`) and `IssueTemplatesJson.templates` (`packages/issues/src/templates/list.ts:12`) still restate that shape inline: `{ name, version, source, path, sections: { id, heading, required, guidance }[] }[]`, about 12 lines in each.
- The scope side of ?44 aliases the shared type (`UnresolvedAnchorJson = UnresolvedAnchor`); the template side does not. A field added to `ListedTemplate` would reach the JSON output at runtime without showing up in the tools' declared types.

## Done when
- `TemplatesJson.templates` in `packages/adr/src/templates/list.ts` and `IssueTemplatesJson.templates` in `packages/issues/src/templates/list.ts` are typed `readonly ListedTemplate[]` (imported from `@nikovirtala/ledger`), with no inline restatement of its fields.
- The JSON output of `adr_templates` and `issues_templates` is unchanged: the existing tests of both tools pass without changes to what they assert.
