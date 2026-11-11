# Pi worker profiles and upgrade checks

Read this when a Pi installation has many extensions, workers call unrelated tools, or a model task reaches its deadline without agent_settled. These controls apply to Pi on Windows, macOS and Linux.

## Choose a profile

The default `inherit` preserves existing Pi startup behavior, model, authentication, proxy and automatic loaders. Opt into `minimal` for a bounded worker with automatic extension, MCP, skill and prompt-template loading disabled. This can remove unrelated tools and context; it does not guarantee a faster model response or fix an incompatible third-party plugin.

Set `PI_BRIDGE_WORKER_PROFILE=minimal` in the launching process or the MCP environment. `PI_BRIDGE_PI_ARGS` is a JSON string array of additional loader arguments. For example:

```json
["--extension", "/absolute/path/to/machine-policy/index.ts"]
```

Explicit loader controls supported: `--extension` / `-e`, `--skill`, `--prompt-template`, the four `--no-*` flags, and `--thinking`. Explicit extension/skill/template paths must be existing absolute local paths. Keep required machine policy extensions explicitly enabled. Review the capability change before selecting minimal; it disables all automatic extensions, including built-ins. Requested scientific methods, task constraints, commands and acceptance criteria belong in the delegated task.

For per-instance configuration, create or merge `<instance-home>/bridge.config.json` before starting that instance:

```json
{
  "pi": {
    "profile": "minimal",
    "args": ["--extension", "/absolute/path/to/machine-policy/index.ts"]
  }
}
```

Replace the example path with the actual policy file, or use an empty `args` array when no explicit policy is required. Instance-home is `<state-root>/<instance>` for Pi. Existing instance configuration overrides environment defaults. No global Pi or PiDeck file is edited. RPC mode, credential arguments and Bridge session-directory overrides are refused in these extra arguments.

Before the first profiled worker starts, Bridge runs the selected Pi's `--help` and checks support for the requested loader flags. Older Pi versions that do not advertise a required option fail with an actionable diagnostic. This preflight makes no model request. Bridge passes arguments directly to the original Pi process; no wrapper or extra child-process layer is introduced.

## Keep CLI and MCP consistent

Run `pi-bridge mcp-config` in the same configured environment. The output includes the resolved backend entrypoint, worker profile and extra arguments, and an explicit state root when configured. Copy the complete output including `[mcp_servers.pi_bridge.env]`. This allowlist excludes model credentials and unrelated environment variables. Pi keeps ownership of its existing authentication and proxy configuration.

Check `doctor` for the configured profile, loader arguments, reported actual model and thinking level (when supplied by Pi). Loader configuration is not an inventory of every tool actually registered by extensions.

## Update and verify

Install a versioned release into a separate directory first. Check status before stopping only the instance being upgraded. A daemon retains its startup configuration: changes apply after that instance is restarted; an MCP environment change also requires reconnecting its MCP server. Other instances and daily PiDeck use remain unchanged.

Use a fresh instance and temporary Git workspace for live acceptance. For the included development smoke checks, explicitly enable `BRIDGE_LIVE_TEST=1`; run `npm run test:smoke` from the source checkout. `BRIDGE_SMOKE_TIMEOUT_SECONDS` defaults to 300 and can be set to an integer from 30 to 3600. Longer choices may also require increasing the outer Node test timeout. Production task deadlines remain task-owned and retain their existing defaults.

A successful live test must observe agent_settled, report passed / verified and contain an independent verifier exit code 0 checking the requested content. File existence, doctor health and an agent_end event alone do not establish completion. The smoke tests fail when an explicitly enabled model probe or full task fails; disabled live tests are skipped. Review logs on timeouts before retrying, and preserve failed-workspace evidence when reproducing a host-specific issue.

On rollback, restore the earlier package/configuration for the affected idle instance; select inherit (and clear extra args) to restore automatic loaders. Regenerate the MCP snippet after changing executable paths or profile environment.

## Evidence behind this option

A supplied macOS ARM64 / Node 24.21.0 / Bridge 0.3.0 report records two CLI tasks passing with minimal loaders and an explicitly retained machine-policy extension. The full extension combination had a tracker argument rejection; short deadlines also expired with minimal loaders. The report does not establish an operating-system fault, a lost completion event, or a single universal latency cause. An aborted stream message recorded after cancellation does not by itself prove a spontaneous service failure. The reported MCP check covered handshake and tool discovery, while complete model acceptance used CLI. This release integrates the configuration mechanism; validation on the current development host is recorded separately in VALIDATION.md.
