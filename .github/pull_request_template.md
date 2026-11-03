## Summary

<!-- What does this change do, and why? Describe the change, not the mechanics. -->

## How tested

<!-- List the checks you ran and their results. -->

- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] `pnpm check` (lint, build, test)
- [ ] `node packages/adr/dist/cli.js verify` prints `No findings.`
- [ ] `node packages/issues/dist/cli.js verify` reports 0 errors

## Documentation

- [ ] Docs updated (README, package READMEs, or `docs/`), or not needed because: ___

## Changeset

- [ ] Ran `pnpm changeset` for a releasable change (see [RELEASING.md](../RELEASING.md)), or this change is not releasable.

## Filed for later

<!--
Follow the review-findings workflow in AGENTS.md: list any low-priority
findings filed with the issues tool, each with a relates-to link. Write
"None" if there are none.
-->

None

## Conventions

This repository follows the workflow in [AGENTS.md](../AGENTS.md): linear history, atomic Conventional Commits, and no squash merges.
