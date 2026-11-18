---
"@nikovirtala/adr": minor
"@nikovirtala/issues": minor
---

`adr init` and `issues init` write `[policy] auto_commit = true` in the config they create, so in a log they set up every write from the CLI or MCP commits, and `--no-commit` only stages. The built-in default stays `false`: a config without the key, including every config written before this release, keeps staging. `init` itself still commits only with `--commit`, or when a config it finds sets `auto_commit`.
