# Fix the subcommand help and two show messages

## Goal
Make issues' subcommand help describe every option, and fix two messages of `issues show` (rough edges 10, 11 and 12 of PR #22).

## Notes
- **Subcommand options have no descriptions (rough edge 10).** `issues link --help` lists `--rel <value>` with no values or default (`relates-to`); only the usage line names the values. `issues new --help` lists `--section <value>`, and only the usage says `<id>=<markdown>`. `--no-commit` and `--no-edit` appear in the usage lines but not in the options lists. From 0.1.0:

  ```
  Usage: issues link <issue> <target> [--rel depends-on|part-of|relates-to|implements] [--commit | --no-commit] [-m <message>]

  Options:
    --rel <value>
    --commit
    -m, --message <value>
  ```

  ledger's `runCli` (`packages/ledger/src/cli/run.ts`) prints the options from each command's `parseArgs` config, which has no description field.
- **Plural for one blocker (rough edge 11).** `issues show 6930v8w9` prints `BLOCKED by 1w06qws8 (open). Finish them first.` (`packages/issues/src/views.ts`).
- **`show --history` drops on whose behalf an agent acted (rough edge 12).** It prints `2026-10-26T20:29:12Z opened by kiro` for an event that records `on_behalf_of: nikovirtala@users.noreply.github.com` (`packages/issues/src/cli/text.ts`).

## Done when
- Every option in `issues <command> --help` has a description; `link --help` lists the `--rel` values and the default `relates-to`; `new --help` and `edit --help` show `--section <id>=<markdown>`; every negated option in a usage line (`--no-commit`, `--no-edit`) is in the options list. A test covers `link --help` and `new --help`.
- `issues show` says "Finish it first." for one open blocker and "Finish them first." for more, with a test.
- `issues show --history` shows on whose behalf an agent acted, for example `opened by kiro on behalf of nikovirtala@users.noreply.github.com`, with a test.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
