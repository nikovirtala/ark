# Releasing

Packages are versioned independently with [Changesets](https://github.com/changesets/changesets) and published to npm from GitHub Actions ([release.yml](.github/workflows/release.yml)) with npm trusted publishing and provenance. No `NPM_TOKEN` secret is used.

## Flow

1. With a change that should be released, run `pnpm changeset`, pick the packages and bump types, and commit the generated file.
2. When that reaches `main`, the release workflow opens or updates the **"chore: version packages"** PR, which bumps versions, writes changelogs and deletes the consumed changesets.
3. Merging the version PR publishes the bumped public packages to npm with provenance and creates their git tags and GitHub releases.

Only packages with changesets are bumped; there are no fixed or linked groups. Private packages (currently `@nikovirtala/issues`) are never versioned or published.

The version PR is opened with `GITHUB_TOKEN`, so it doesn't start CI by itself. Re-run CI from the Actions tab, or push an empty commit to the version branch, if a run is needed before merging. CI lints commit messages, so give that commit a Conventional subject, such as `git commit --allow-empty -m "ci: run checks on the version pull request"`.

## One-time setup

1. **Placeholder publish.** npm can only configure a trusted publisher on a package that exists. From an empty temporary directory (not this repo), logged in to npm with your own account:

   ```sh
   cat > package.json <<'JSON'
   {"name":"@nikovirtala/ledger","version":"0.0.0","description":"placeholder","license":"MIT","repository":{"type":"git","url":"git+https://github.com/nikovirtala/ark.git"}}
   JSON
   npm publish --access public
   npm deprecate @nikovirtala/ledger@0.0.0 "placeholder, use 0.1.0 or later"   # optional
   ```

2. **Trusted publisher.** On npmjs.com: `@nikovirtala/ledger` → Settings → Trusted publisher → GitHub Actions:
   - Organization or user `nikovirtala`, repository `ark`, workflow filename `release.yml`, no environment.
   - Check **"Allow npm publish"**. New configurations default to stage-only, and Changesets doesn't support staged publishing.
   - A new configuration expires if it doesn't publish within 2 days. Create it right before merging the version PR, or delete and recreate it if it expired.
3. **Optional:** Settings → Publishing access → "Require two-factor authentication and disallow tokens".
4. **GitHub Actions.** Repository Settings → Actions → General: enable "Allow GitHub Actions to create and approve pull requests", so the release workflow can open the version PR.
5. **Merging.** Settings → General → Pull Requests: allow only "Rebase and merge" (linear history, see [AGENTS.md](AGENTS.md)). Optionally protect `main` and require the CI `check` job.
6. Placeholders for `@nikovirtala/adr` and `@nikovirtala/issues` were published on 2026-10-22 (version 0.0.0, deprecated), so step 1 is already done for them. When a package drops `"private": true`, do step 2 for it right before merging the first version PR that publishes it.

## Troubleshooting

- **`ENEEDAUTH` or 404 on publish:** check that the trusted publisher names `release.yml` (renaming the workflow breaks it), that `repository.url` in the package's `package.json` is `git+https://github.com/nikovirtala/ark.git`, that the configuration hasn't expired and that "Allow npm publish" is checked.
- If the settings are right and pnpm's native publish still fails the OIDC exchange, set `script: pnpm exec changeset publish` on the publish step in `release.yml`.
