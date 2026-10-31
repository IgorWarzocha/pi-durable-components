# npm publishing

The npm workflow publishes all 25 packages from the exact archives of a published GitHub release after checking its manifest and SHA-256 checksums. It preflights all package versions against the public npm registry. An existing version is skipped only when its registry integrity matches the archive. A conflicting version stops the run before any publication. The first npm release is `v0.9.1`.

## Bootstrap

Do not run this until publication is authorised. First push the workflow to the default branch and confirm that the `@howaboua` npm scope belongs to the intended account or organisation. Create a short-lived granular npm token with permission to create and publish all 25 packages in that scope, including bypass 2FA if required by npm's current policy. Add it as the repository Actions secret `NPM_TOKEN`.

Run **Publish release to npm** from GitHub Actions with tag `v0.9.1` and authentication `bootstrap`. The token is used only by that step. The workflow does not create package settings or credentials. If a run is interrupted, review its output and run it again with the same tag. Already published archives must have matching integrity.

Successful uploads are not necessarily installable immediately. npm [scans packages before making them available](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/), and public registry reads can return 404 while scanning is pending. Wait for the versions and tarballs to become readable, then verify their integrity against the release archives. Do not retry a successful publication merely because scanning has not finished. A held or blocked package needs the maintainer's review rather than a new version to bypass the check.

The v0.9.0 archives were built before the repository metadata added for trusted publishing. They are bootstrap archives, not eligible for this workflow's trusted-publishing preflight. They are not rebuilt or replaced.

## Trusted publishing for later releases

After bootstrap, configure a trusted publisher on each npm package. Use GitHub owner `IgorWarzocha`, repository `pi-durable-components` and workflow filename `publish-npm.yml`. Allow direct `npm publish`. The workflow uses a GitHub-hosted runner, Node 24 and `id-token: write`. No npm publishing token is used in trusted mode. Automatic npm provenance is disabled because this job downloads release archives rather than building those bytes. It must not claim their build occurred in this workflow.

New trusted publisher configurations expire if they do not complete their first successful publish within two days. Configure all packages immediately before the next release, not during idle preparation. A newly built release must include the matching `repository` metadata from its package manifests. Check all trusted-publisher entries before publishing the GitHub release. A published stable release automatically starts the workflow; a manual run can select `trusted` for recovery. Prereleases do not trigger automatic publication.

Upload all archives, `artifacts.json` and `SHA256SUMS` while the GitHub release is still a draft. Publish it only after the complete asset set is present. Asset uploads after publication do not retrigger the workflow. Manual runs also reject draft and prerelease tags. If publication starts before the assets are ready, finish the upload and rerun the workflow manually.

After successful trusted publication, restrict token-based publishing on npm and revoke the bootstrap token. npm plans to stop allowing direct publishing with bypass-2FA granular tokens in January 2027, so the bootstrap route is not the long-term release mechanism.

## Validate without publishing

Run `node scripts/publish-npm.mjs dist/release-0.9.1 v0.9.1 validate` to inspect the local archive set. Validation never contacts npm or publishes. The publishing modes check the public registry before attempting any upload. Neither validation nor local preparation proves credentials, npm scope ownership or trusted-publisher configuration.
