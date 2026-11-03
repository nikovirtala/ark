# Security policy

Thanks for helping keep ark and the people who use it safe. ark is a suite of git-backed tools (`adr`, `issues`, and the shared `ledger` core) published as `@nikovirtala/*` packages. This policy explains which versions get security fixes and how to report a vulnerability privately.

## Supported versions

Every ark package is at 0.x and still stabilizing, so only the latest published 0.x of each package receives security fixes. When you report an issue, upgrade to the current release first and confirm the problem still happens there. Older 0.x releases do not get backported fixes.

| Package | Supported |
| --- | --- |
| `@nikovirtala/adr` | latest published 0.x |
| `@nikovirtala/issues` | latest published 0.x |
| `@nikovirtala/ledger` | latest published 0.x |

## Report a vulnerability

Report security issues privately. Do not open a public GitHub issue, pull request, or discussion for a vulnerability, because that discloses it before a fix exists.

Use either private channel:

- Open a private report through GitHub security advisories at <https://github.com/nikovirtala/ark/security/advisories/new>. This is the preferred channel and keeps the report, the discussion, and any fix coordinated in one place.
- Or email the maintainer at <niko.virtala@hey.com>.

Include as much as you can: the affected package and version, the environment (Node and git versions, operating system), steps to reproduce, and the impact you observed. A minimal reproduction helps the most.

## Disclosure timeline

This is a small, maintainer-led project, so timelines are targets rather than contractual guarantees.

- Acknowledgement: within 3 business days of your report.
- Assessment: within 10 business days, the maintainer confirms whether the report is a vulnerability and shares an initial severity and plan.
- Fix: the maintainer aims to release a fix in the latest 0.x as soon as practical, prioritized by severity.
- Coordinated disclosure: public details and any advisory are published once a fix is available, crediting the reporter unless you ask to stay anonymous. Please hold public disclosure until then.

If a report stalls, send a polite follow-up through the same private channel.

## Trust boundary

Understanding what ark does and does not control helps you judge what counts as a vulnerability.

- ark tools shell out to your local `git` and run with your git configuration, credentials, and signing setup. They do not add a separate credential store or network service of their own. Treat the host's git setup and the repository you run them in as trusted inputs.
- Configuration is read from repository-local files (`adr.toml`, `issues.toml`) in the tool's root or at the repository root. Running a tool in a repository means trusting that repository's config and template files, the same as running any other tool checked into it.
- Cross-repository references are checked against a local cache and never hit the network during a plain `verify`, a read, a write, or the pre-commit hook. Fetching a source's ref happens only when you ask for it, such as `verify --fetch-sources` or `<tool> sources fetch`.
- Agent writes are attributed, not authenticated. An agent sets `ARK_AGENT` and `ARK_ON_BEHALF_OF`, and events record that actor on behalf of that address; without `ARK_ON_BEHALF_OF`, writes fall back to the git identity with a note. These fields are provenance recorded in the log, not an identity or access-control mechanism, so do not rely on them as a security control.

If you find a case where a tool reads or writes outside the repository it targets, leaks credentials, or executes untrusted repository content beyond invoking git as described above, that is a security issue worth reporting through the private channel above.
