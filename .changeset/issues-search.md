---
"@nikovirtala/issues": minor
---

Add `issues search <query>… [--all] [--source <name>]`: every word must appear, ignoring case and accents, in an issue's id, number, title, description or comments. Open and in-progress issues only unless `--all`; a note counts the closed matches left out. `--source` searches a `[[sources]]` issue log from the local cache. `--json` prints `issues-search/v1`. The library exports `searchIssues`.

Changed behaviour:
- `list --source` naming a decision-log source now says `source <name> is a decision log; --source reads issue logs`.
