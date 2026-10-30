---
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`issues list --source <name>`, `issues search --source <name>` and `adr list --source <name>` print only the `<name> not fetched` note for a `[[sources]]` entry that isn't fetched, without also saying that numbers are unavailable because there is no main branch.
