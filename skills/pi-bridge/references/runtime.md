# Runtime and task contract

Install the versioned package from [GitHub Releases](https://github.com/UWPK/pi-bridge/releases). Node >=22.19, npm, Git, Codex and a configured Pi must be available. Run `pi --help` / `codex --help` in the host environment first. Installing the bridge does not change Pi credentials or model configuration.

The package provides `pi-bridge`, `pi-bridge-mcp`, and `pi-bridge install-skill --apply`. Existing skill directories are never overwritten; use `--destination` for another skill environment. The bridge runtime must remain installed after copying the skill.

## CLI

```text
pi-bridge check-local
pi-bridge up --instance my-chat --apply --json
pi-bridge authorize --instance my-chat --dir <absolute-workspace> --apply --json
pi-bridge delegate --instance my-chat --task-file task.json --apply --wait --json
pi-bridge status --instance my-chat --all --json
pi-bridge logs --instance my-chat --task <task-id> --tail 20 --json
```

Replace angle-bracket arguments with actual values. `--instance` is optional when the host passes CODEX_THREAD_ID or CODEX_SESSION_ID. State roots: Windows LOCALAPPDATA/pi-bridge, macOS ~/Library/Application Support/pi-bridge, Linux XDG_STATE_HOME/pi-bridge or ~/.local/state/pi-bridge. Override with `--state-root` or PI_BRIDGE_STATE_ROOT. State from the machine-specific legacy bridge is deliberately kept separate.

## MCP

`pi-bridge mcp-config` prints a Codex TOML entry containing absolute Node and MCP entrypoint paths. Add the entry to the intended Codex MCP configuration or register the equivalent stdio command in the host UI. It only prints configuration and never rewrites Codex settings.

MCP tools: check, up, doctor, models, authorize, delegate, status, logs, cancel, resume, down, all prefixed `pi_bridge_`. All require an explicit `instance` shared only within one Codex chat. State-changing tools also require apply:true. Doctor/models can initialize a Pi worker; check performs no model request. Delegate/resume are asynchronous so the MCP tool call does not hold the connection for an entire model run. Poll status through completion and inspect handoff verification.

## Task file

```json
{
  "schemaVersion": "2.0",
  "title": "Create a small example",
  "workspace": "/replace/with/absolute/workspace",
  "mode": "standard",
  "objective": "Create hello.txt containing hello and a newline.",
  "constraints": ["Modify only hello.txt; preserve existing work."],
  "stopConditions": ["Stop if the target already exists."],
  "policy": {
    "allowWrite": true,
    "allowNetwork": true,
    "requireCleanDiff": true,
    "maxWorkerTurns": 12,
    "timeoutSeconds": 300
  },
  "acceptance": [{
    "kind": "command",
    "command": ["node", "-e", "process.exit(require('fs').readFileSync('hello.txt','utf8').trim()==='hello'?0:1)"],
    "timeoutSeconds": 30
  }]
}
```

On Windows use an absolute path such as `C:/work/example`; macOS/Linux use a real absolute workspace. Acceptance commands are argv arrays, executed with shell:false; use a real executable rather than a .cmd shell shim. Pass OS-specific constraints only when relevant to that user's environment. The default policy requires a clean Git worktree; set requireCleanDiff:false only when the task explicitly allows preserving pre-existing changes.

Provider/model are optional. Omitting model passes no provider/model override to Pi; metadata labels the selection `default`. Set `model` to an explicitly chosen provider/model ID when reproducible model attribution is required. API keys remain in Pi's own configuration or process environment.

## Recovery

Use status and a small log tail after interruption. Do not replay an uncertain task blindly. `doctor` with no daemon returns unavailable (exit 4). A running daemon alone does not prove RPC health or a successful model task. Persisted tasks and logs belong to their instance. Failures to terminate a worker block subsequent work until explicit recovery; inspect active tasks before stopping an instance.
