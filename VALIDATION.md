# Release validation

Version: 0.4.1
Date: 2026-11-07

Windows x64 / Node 24.15.0:

- TypeScript build passed.
- 62 unit tests, 46 runtime integration tests and 6 portable interface tests passed (114 total).
- The Pi MCP fixture runs with minimal loader controls and an explicit extension. It emits agent_end before a delayed file write and agent_settled; acceptance waits for the latter and then passes the independent verifier.
- All 6 portable interface tests also passed against the npm-installed release archive, including MCP minimal-profile delegation and the DSH fixture.
- Worker-profile tests cover inheritance, explicit minimal selection, missing policy paths, invalid/reserved arguments and older Pi help without a required flag.
- MCP configuration export preserves the selected executable/profile/arguments while excluding unrelated credential environment variables.
- A fresh independent instance using the real installed Pi 1.4.0 started with all four minimal loader flags and completed an RPC handshake. Doctor reported health ok and the configured model/thinking level. This handshake made no model request; the test instance was stopped afterward.
- Two opt-in model smoke tests were skipped in the default run. Their task/probe timeout defaults to a configurable 300 seconds. Explicitly enabled model failures fail the tests; full-task success requires passed / verified and verifier exit code 0. Production deadlines keep their existing defaults.
- The existing DSH fixture still covers successful delegation, nonzero exit propagation, model-override refusal, backend isolation and full process-tree cancellation.

Separate prior live evidence:

- On this Windows host, version 0.4.0 completed a DSH 0.2.2-rc.1 + QPT DeepSeek task, used PowerShell to create the requested file and returned passed / verified with independent verifier exit code 0. This used explicitly selected direct host execution and does not establish confined execution.
- The user supplied a macOS ARM64 / Node 24.21.0 / Bridge 0.3.0 repair report recording two real CLI tasks passing with minimal automatic loaders and a retained machine-policy extension. That report's MCP evidence covers handshake/tool discovery, not full live-model delegation. It also records a shorter-deadline timeout with minimal loaders.

Current-release macOS/Linux machine-level acceptance remains outstanding. Pi model/credential/proxy settings and installed local skills were not edited. The new profile is opt-in and is not a universal fix for model latency or third-party plugin errors. agent_end is not treated as agent_settled. DSH continues to use its own headless configuration; its internal turns, tools and token use remain unavailable through this adapter.
