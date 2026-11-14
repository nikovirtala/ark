# Read --section text from a file or stdin

## Problem
Multi-line markdown in `--section id=<markdown>` needs careful shell quoting. Kiro got it working with shell variables after some trial and error, and the README shows no multi-line example.

## Proposal
Accept `--section id=@path` to read a file and `--section id=@-` to read stdin, as curl does, in every ledger-based tool, and document both.

## Done when
- `--section id=@path` and `--section id=@-` work for `new` and `edit` in adr and issues; `@@` at the start passes a literal @.
- A missing file is refused with its path, and nothing is written.
- `--help` for `new` and `edit` shows the @ forms.
- The READMEs show a multi-line section with a heredoc on stdin, and mention that agents with MCP can pass a sections map instead.
