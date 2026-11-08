---
name: pi-bridge
description: Delegate explicitly requested, bounded tasks from Codex to an installed Pi coding agent or DeepSeek Harness (DSH) through the portable pi-bridge CLI or MCP tools, then check actual changes and independent acceptance results.
---

# Pi Bridge

Use when the user explicitly requests delegation to Pi or DSH. Codex plans, sets the workspace and acceptance criteria, and reviews results; Pi performs the bounded task. Pi workers must complete their task without recursively invoking this bridge.

## First installation and model choice

For installation, reinstallation or a model change, read [setup.md](references/setup.md). Establish the selected backend and provider/model before a model request: ask for missing choices and reuse explicit choices already made in the chat. Keep credentials local and record Bridge-specific selections without changing daily Pi/PiDeck defaults. After installing, verify the actual installed runtime with a fresh bounded task and independent acceptance.

Before Pi's startup check, Pi may need to create and remove a short-lived trust lock in its own agent state directory (normally `~/.pi/agent`). If host approval is required, explain the exact operation and path to the user and wait for the user to approve it through the host's own prompt. Never ask Pi to draft, submit or retry an approval request. If automatic review rejects the request, stop and report the rejection; do not seek an equivalent permission through another route or widen access to the home directory. Follow [runtime.md](references/runtime.md) for one-command setup.

When present, read the installation's `references/local-installation.md` for the actual local entrypoint and saved choices; this machine-specific file is generated locally and is not shipped by the generic package.

## Runtime discovery

Requires Node.js >=22.19 (24 LTS recommended), Git for diff evidence, and a selected backend (Pi or DSH) with working model access. DSH currently requires Node >=24.9.0. Windows, macOS and Linux use the same Node entrypoints. See [runtime.md](references/runtime.md) for installation, MCP setup and task contracts.

Use `pi-bridge check-local` to locate Pi without model calls. Select DSH with `--backend dsh` or MCP argument backend:"dsh" and read [dsh.md](references/dsh.md). DSH can run without Pi installed. A custom installation can set BRIDGE_PI_CLI to its JS entrypoint or native executable. Keep existing Pi authentication, settings, plugins and proxy configuration. The default model comes from Pi; BRIDGE_PI_PROVIDER / BRIDGE_PI_MODEL optionally select a user-authorized alternative.

For plugin-heavy Pi installations or upgrade acceptance, read [worker-profiles.md](references/worker-profiles.md). Keep the default `inherit` unless a minimal worker is intended; explicitly retain required machine-policy extensions when disabling automatic loaders. Reuse the same profile settings for CLI and MCP. A task completes after `agent_settled` and independent verification; `agent_end` alone is insufficient.

## Choose one interface

- If `pi_bridge_*` MCP tools are available, use them. Every call requires the same unique `instance` for this Codex chat, normally `chat-<CODEX_THREAD_ID>` or `chat-<CODEX_SESSION_ID>`. For hosts without these values, establish a unique instance name once and reuse it.
- Otherwise use `pi-bridge` on PATH, or `node <installed-package>/bin/pi-bridge.mjs`. CLI selects the Codex thread identity automatically or requires `--instance NAME`. No shared default daemon is created.

Use the same backend for all calls concerning one task. DSH runs a fresh headless session per task/resume, uses its own model configuration, and cannot expose or limit its internal turn count through this adapter. Its host timeout and independent verifier remain active.

State is separated by backend and instance. Do not reuse another chat's instance or run competing writers in one workspace.

## Delegate and review

1. Establish the actual workspace, user-authorized changes, provider/model, timeout, stop conditions and acceptance argv. Check which tools Pi can actually use and pass relevant shell/file restrictions in task constraints.
2. Start the instance (`pi_bridge_up` with apply:true, or CLI `up --apply`). Authorize only the intended workspace using `pi_bridge_authorize` or CLI `authorize --dir <absolute-workspace> --apply`.
3. Submit a schema-2.0 task using `pi_bridge_delegate` with apply:true or CLI `delegate --task-file <file> --apply --wait --json`. MCP submits asynchronously; keep polling `pi_bridge_status` to a terminal state. Inspect failures before resubmitting.
4. Inspect the actual diff, independent verifier exit codes, task status and residual issues. Worker text alone cannot establish acceptance. Missing verifier evidence produces at most a partial handoff.
5. Cancel/resume only the current instance's known task, with apply:true / --apply. Preserve idle daemon and worker for reuse. Stop with `down` only when requested or recovery requires it.

The runtime uses trusted host execution with Pi's existing OS permissions. It rejects requested read-only, offline and subdirectory confinement that it cannot enforce. Whole-workspace host execution requires explicit allowWrite:true and allowNetwork:true; choose a genuinely isolated runtime when tighter boundaries are needed. Authorization does not make filesystem or network isolation available.

If subprocess creation is denied, use the host's authorized execution channel or report the block; leave OS permissions and ACLs unchanged. Report dependency checks, RPC health, real model execution and verified acceptance as separate facts. Read bounded, redacted log tails when needed.
