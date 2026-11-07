# DSH headless backend

This adapter implements the official [DSH headless CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md): `dsh --profile headless <task>` runs one fresh persisted session, returns final text and exits. DSH also offers SDK JSON-RPC and ACP; these are separate protocols and are not interchangeable with Pi RPC.

Select `--backend dsh` in CLI commands, or `backend:"dsh"` in every related MCP call. Install/configure DSH independently; no Pi installation is required. `BRIDGE_DSH_CLI` can identify a custom DSH JavaScript entrypoint or native executable. Current published DSH 0.2.2-rc.1 declares Node >=24.9.0. A later DSH version should be checked against its own requirements.

The runtime uses DSH's existing model, credentials, profile and permission configuration. It does not reset profiles or patch home settings. Omit task.model; explicit overrides are rejected. The headless profile may initialize its shipped profile on first real execution, following DSH behavior. DSH's own permission and approval mechanism can further constrain a submitted host task.

## Supported and unavailable behavior

- Bridge submission, persistent task state, independent argv verification, overall timeout and cancellation are supported.
- Headless creates a fresh session for every task. Resume re-executes the task in a fresh DSH session against the current workspace, so inspect existing changes and make tasks safe to retry.
- The reusable process is a small control adapter. DSH itself launches once per task. Doctor checks the adapter control channel, while check-local checks discovery; neither proves real DSH model access.
- The adapter receives final stdout and exit status, while draining reasoning stderr without returning it to Codex. Prompts are passed as a CLI argument as required by headless; stay below 20000 characters, and avoid including credentials.
- Internal turn/tool counts and token usage are unavailable. The inherited maxWorkerTurns policy cannot limit DSH internal loops. Use timeoutSeconds for the host wall-clock limit; handoff risks record this limitation. Do not describe this adapter as enforcing a DSH model-call budget.
- Model enumeration is unavailable through this adapter; models returns supported:false. No model name is inferred from final text.
- A nonzero DSH exit becomes backend_failed even if an independent verifier happens to pass. Model errors never become successful execution merely because an old output file exists.
- Cancellation retires the adapter's entire process tree, including DSH and its children. A failure to confirm termination blocks further runs in that instance.

Pi and DSH use separate instance state. The external command names and MCP prefix remain pi-bridge / pi_bridge_* for backward compatibility.

## Example task

Use the schema-2.0 task in [runtime.md](runtime.md), remove model, set the actual workspace and acceptance argv, and submit with the DSH backend. The permission flags describe the trusted host execution request; they do not replace DSH's own permission system. Check status, actual changes and verification evidence before accepting completion.

Validation distinguishes simulated DSH protocol/process tests, real installed CLI help and real model tasks. A simulated test does not establish model access, credentials, tool availability or real service reliability.
