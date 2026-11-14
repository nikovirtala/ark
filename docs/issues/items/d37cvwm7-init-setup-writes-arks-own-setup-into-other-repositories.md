# init --setup writes ark's own setup into other repositories

## Summary
`adr init --setup --skill` writes ark's setup, not a generic one, because the shared code (`arkSetup` in `packages/ledger/src/surfaces/ark-setup.ts`) builds in ark's pins, ark's `prepare` script, hooks for both tools and references to ark's records. A user found six problems in another repository (longplay). The design's only check was R9, which reproduces ark, so nothing tested any other repository. docs/03-setup-v1.md now says how the generic setup and ark's specifics separate ("Every other repository"), with R10 and R11.

## Steps to reproduce
1. In a repository that uses adr but not issues, with a `package.json` and no `scripts/git-hooks.mjs`, run `npx @nikovirtala/adr@0.6.0 init --setup --skill`.
2. Read the MCP configs, hook scripts, `package.json` and `AGENTS.md` it writes.
3. Run `pnpm install`.
4. Remove the `nygard` template and run the command again.

## Expected
A setup for adr 0.6.0, for this repository: pins of the version that ran, only adr's pieces, no `prepare` script unless asked, generated text that explains itself without ark's records, no templates on a rerun, and an install that still succeeds.

## Actual
1. The MCP configs and hooks pin `@nikovirtala/adr@0.5.10` and `@nikovirtala/issues@0.5.6`, ark's previous-release pins (ADR-0017), not 0.6.0.
2. `package.json` gets `"prepare": "node scripts/git-hooks.mjs install --if-built"`; the file exists only in ark, so the script exits 1 and `pnpm install` fails.
3. The hooks run `issues hooks install`, `issues list` and `issues ready` in a repository without issues.
4. The hook scripts cite ADR-0017 and docs/03-setup-v1.md, which don't exist there.
5. The rerun writes the `nygard` template again after it was removed.
6. `AGENTS.md` tells every agent to read `SKILL.md`, including agents that load the skill copies init also writes.

## Done when
- Outside ark, `adr init --setup` and `issues init --setup` pin the running tool's own version and write only that tool's pieces; hooks for a tool the repository doesn't use are never written (R10).
- No `prepare` script is written unless asked (`--prepare`), and an existing one is never replaced; missing git hooks are installed by the session-start hook (R6) and reported by doctor.
- A rerun writes no templates; a template the config doesn't use stays removed.
- Generated files explain themselves and link the tool's README; nothing refers to ark's records or design docs.
- The `AGENTS.md` line says it is for agents that don't load skills, and points to one copy.
- ark's previous-release pins and build-safe `prepare` come from ark's own config, and the release pin bump (?61) changes that config; R9 still passes with no diff.
- CI runs the fixture repositories R11 names: a repository with only adr, a JavaScript repository without ark's scripts, and one with no `package.json`. In each it checks that the install succeeds, every hook script runs, nothing generated names ADR-0017, `03-setup` or an unused tool, and a second run changes nothing.
- `init --setup --help` and the READMEs say what the setup writes in a repository and how a repository overrides the pins.
