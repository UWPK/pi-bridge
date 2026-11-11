# Validation

## Automated acceptance

The first-run implementation passed full test suites and fresh-package installation on Windows, macOS Apple Silicon, macOS Intel and Linux in [GitHub Actions run 42510416965](https://github.com/UWPK/pi-bridge/actions/runs/42510416965). This run predates the current documentation cleanup and integration with the latest main branch; the PR checks validate the current revision.

Local macOS acceptance included 62 unit tests, 44 integration tests and 8 portable interface tests; two Windows-specific integration tests were skipped. Portable tests also passed against a packed archive installed into a fresh directory.

Coverage includes CLI/MCP transport, separate instances, independent verification, repeated installation, preservation of modified skills, Pi startup failures, failed model-task acceptance and cleanup. CI uses simulated backends and no model credentials.

## Live model acceptance

Historical Windows v0.4.2 acceptance included a real Pi MCP task with passed/verified handoff and independent verifier exit code 0. It does not establish current-version live model compatibility on every platform.

The new optional `setup --apply --verify` path has been tested with simulated Pi processes. Its real-provider acceptance remains outstanding. Dependency discovery, Pi RPC health, a real model task and host MCP connectivity are separate checks; none should be substituted for another.

## Reproduce

```text
npm ci
npm test
npm pack
```

Test the resulting archive in a fresh installation prefix. For explicitly authorized real model acceptance, run the installed setup command with `--apply --verify` and the intended Pi entrypoint/profile. This can incur model charges. Successful test evidence is cleaned; failed evidence is retained for diagnosis. Host permissions and model credentials remain the user's responsibility.
