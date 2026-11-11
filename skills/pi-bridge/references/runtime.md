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


For optional minimal Pi workers, explicit policy extensions, MCP environment export and a configurable 300-second upgrade smoke check, read [worker-profiles.md](worker-profiles.md).

## Recovery

Use status and a small log tail after interruption. Do not replay an uncertain task blindly. `doctor` with no daemon returns unavailable (exit 4). A running daemon alone does not prove RPC health or a successful model task. Persisted tasks and logs belong to their instance. Failures to terminate a worker block subsequent work until explicit recovery; inspect active tasks before stopping an instance.

## One-command local setup

After npm installs the release package, use `pi-bridge setup --apply` to verify
Git and the actual Pi executable, validate worker flags, install the skill, and
return a complete MCP snippet without editing client settings or credentials.
Pi startup checks, including `--help`, may create a temporary trust lock under
Pi's agent state directory (normally `~/.pi/agent`). On approval-gated hosts,
the user must approve only that directory's normal lock-file create/remove
operation through the host prompt. State the exact operation and path; do not
have Pi draft or submit an approval request. If automatic review rejects it,
stop and report the rejection instead of retrying through another route or
widening permissions to the whole home directory. Resume setup only after the
user approves through the host prompt.
Use `--destination PATH`, `--pi-cli PATH` or explicit `--profile minimal` when
needed. Identical skills can be reused; changed skills are preserved and setup
stops for review. Registration of the emitted MCP configuration and an actual
model task remain separate from this no-model setup check.


## Setup results and optional model verification

`setup` requires a runtime release containing this command; check the installed CLI help first. Basic setup is available in v0.4.3; staged reports and --verify require a later runtime or this source build. If unavailable, report the version mismatch and use the documented individual commands; do not claim setup succeeded.

`setup --apply` reports staged checks, expected state/skill paths and a complete MCP snippet. `installed` means dependency/startup checks and skill installation passed, not model execution. With explicit user authorization for a small model request, add `--verify` using the same options. It creates a separate temporary Git workspace and instance, delegates one file-creation task and requires passed/verified handoff plus independent verifier exit code 0 and matching file contents. It stops its own instance; successful evidence is removed, failed evidence is retained with its path/task ID. Inspect failed evidence before a new verification, which can incur another model charge.

`verified` and `modelVerified:true` establish only the CLI task/acceptance path. Register the emitted MCP snippet and check the actual host connection separately. `blocked` or `verification-failed` includes a next action. Do not repeat a denied command or turn an error into a success claim. Host rejection before launch cannot be caught by the program; report the host's actual reason and wait for its authorized resolution. Setup never grants persistent permissions or edits authentication/client settings. Reuse existing model/backend choices for ordinary tasks; ask again only for a changed or missing choice.
