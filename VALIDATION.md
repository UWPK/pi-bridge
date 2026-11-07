# Release validation

Version: 0.4.0

Windows x64 / Node 24.15.0:

- TypeScript build passed.
- 59 unit tests passed.
- 46 runtime integration tests passed with simulated Pi and real subprocess/verifier execution.
- 5 portable interface tests passed, including the Pi MCP path and a DSH headless fixture path.
- DSH tests exercise success, nonzero exit propagation even when an old file satisfies verification, rejection of model overrides, backend state isolation and process-tree cancellation.
- DSH registry metadata was checked: @deepseek-ai/dsh 0.2.2-rc.1 declares Node >=24.9.0.
- Official DSH 0.2.2-rc.1 was installed into an isolated prefix; --version, --help and Bridge check-local --backend dsh passed without model requests.
- The same 5 portable interface tests passed against the npm-installed v0.4.0 package.
- 2 real-model smoke tests remain opt-in and are skipped by default. Real DSH model execution has not been verified with user credentials.

The DSH adapter invokes the documented headless profile. It does not implement the DSH SDK or ACP protocols. DSH session continuation, internal turn/tool accounting, token usage and model enumeration are not supplied by this adapter. Task wall-clock timeout and independent acceptance remain active.

macOS/Linux use portable Node APIs; full machine-level real-model acceptance remains outstanding. Existing local Bridge, skill and Codex/Pi settings remain unchanged.
