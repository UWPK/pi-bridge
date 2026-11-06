# Release validation

Version: 0.3.0

Validated on Windows x64 / Node 24.15.0:

- TypeScript build passed.
- 59 unit tests passed.
- 46 runtime integration tests passed (simulated Pi, real subprocesses/verifiers).
- 4 portable interface tests passed: discovery/model selection, instance separation, safe skill installation/MCP configuration, stdio MCP end-to-end task and acceptance.
- The same 4 interface tests passed against the npm-installed prebuilt package.
- The installed package detected the local Pi entrypoint without a model request.
- 2 real-model smoke tests were explicitly skipped by default; no real-model success is claimed for this release.

macOS/Linux use portable Node APIs but have not received full machine-level, real-model acceptance in this release. Native Pi executable discovery is supported; the validated local Pi installation is npm-based. Users need their own working Pi authentication, model access and environment.

Existing local bridge runtime, skill, Codex configuration and Pi settings were left unchanged.
