# Bump ark's own tool pins when a release publishes

## Goal
Make the release workflow update the exact versions ark's own agent tooling is pinned to, so ark starts using each release on itself through a reviewed pull request.

## Notes
This is the self-update step of the proposed decision to run ark's own tooling from the previous release (adr:jgdhvxtq). Once init is rerunnable, the step is: bump the pins and rerun init, in the version pull request or one opened right after the publish.

## Done when
- After a release publishes new versions of adr or issues, a pull request bumps every pin in ark's agent configuration to them.
- That pull request reruns the tools' setup, and CI passes on it before it is merged.
