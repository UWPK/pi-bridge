# Release validation

Version: 0.4.2

This release adds initial-install/reinstall guidance and a backend/provider/model selection step to the skill. Already confirmed choices are reused, credentials stay local, and Bridge-specific Pi model selection preserves daily Pi/PiDeck defaults. Runtime behavior is unchanged from 0.4.1 apart from version metadata.

Version 0.4.1 validation: 62 unit tests, 46 integration tests and 6 portable interface tests passed (114 total). A real Pi 1.4.0 minimal-profile RPC handshake passed without a model request; all 6 portable tests also passed against its installed release archive. The supplied macOS repair report validates its own 0.3.0 CLI tasks. Current-release macOS/Linux full-model acceptance remains outstanding.

Version 0.4.2 verification on Windows x64 / Node 24.15.0:

- TypeScript build and all 6 portable interface tests passed.
- The public GitHub release archive installed with one npm invocation into an empty Bridge-specific prefix on E (96 packages).
- The previous active legacy runtime/skill were backed up and replaced; backend authentication and daily Pi/PiDeck defaults were retained.
- The freshly installed MCP service exposed 11 tools, passed backend discovery and real Pi RPC health checks, and confirmed the user-selected QPT DeepSeek model.
- One real MCP-delegated task used PowerShell to create the requested single file, reached agent_settled, and returned passed / verified with independent verifier exit code 0 in approximately 12 seconds.
- Additional PowerShell review confirmed exact output including a single Windows newline. The test instance was stopped afterward.
- Codex CLI read back the newly registered MCP as enabled with the intended provider/model/profile.
- The local setup required newline correction when appending generated TOML. The first local test reader also needed to parse the nested payloadJson object structurally; the original successful task evidence was reviewed without another model request. No package runtime patch or second npm installation was required.

The detailed installation record and local paths remain outside this repository. Live model requests remain opt-in; dependency discovery, RPC health and verified task completion are separate observations. Current-release macOS/Linux, long-task and recovery scenarios were not retested by this Windows clean-install check.
