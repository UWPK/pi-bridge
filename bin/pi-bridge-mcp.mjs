#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { identity, runCli } from './common.mjs';
import { join, dirname, isAbsolute } from 'node:path';
import { resolvePiCli, resolveDshCli } from '../dist/src/config.js';
import { parseTaskRequest } from '../dist/src/schema.js';
import { redactText } from '../dist/src/redact.js';
const context = identity(process.argv.slice(2), true);
const text = description => ({ type: 'string', description, minLength: 1 });
const definitions = [
 ['check', 'Check local Node and selected Pi/DSH executable without calling a model.', {}, []],
 ['up', 'Start this instance daemon. Does not submit a model task.', {}, []],
 ['doctor', 'Check daemon and initialize its backend control adapter if needed; DSH health covers the adapter only.', {}, []],
 ['models', 'List Pi models; DSH headless reports model enumeration unavailable.', {}, []],
 ['authorize', 'Authorize an absolute trusted host workspace for this instance after user authorization.', { directory: text('Absolute workspace path') }, ['directory']],
 ['delegate', 'Submit a user-authorized schema-2.0 task asynchronously. Poll status for verification and completion. Host execution uses Pi permissions.', { task: { type: 'object', description: 'schemaVersion 2.0 TaskRequest; include workspace, objective, title, mode, policy and acceptance argv.' } }, ['task']],
 ['status', 'Read task status and independent acceptance evidence. Omit taskId to list tasks.', { taskId: text('Existing task ID') }, []],
 ['logs', 'Read a bounded tail of redacted task logs.', { taskId: text('Existing task ID'), tail: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, ['taskId']],
 ['cancel', 'Cancel a task in this instance and terminate its worker.', { taskId: text('Existing task ID') }, ['taskId']],
 ['resume', 'Resume an eligible task asynchronously after checking existing state.', { taskId: text('Existing task ID') }, ['taskId']],
 ['down', 'Explicitly stop this instance daemon and worker; use only when user requests or recovery requires it.', {}, []],
];
const mutations = new Set(['up', 'authorize', 'delegate', 'cancel', 'resume', 'down']);
const tools = definitions.map(([action, description, properties, required]) => ({
 name: `pi_bridge_${action}`, description,
 inputSchema: { type: 'object', properties: { backend: { type: "string", enum: ["pi", "dsh"], description: "Execution backend; defaults to pi. Reuse the same backend for a task." }, instance: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$", description: "Unique Codex chat identity, e.g. chat-<thread-id>. Reuse for all tools in that chat." }, ...properties, ...(mutations.has(action) ? { apply: { type: 'boolean', const: true, description: 'Confirm the user-authorized state change' } } : {}) }, required: ["instance", ...required, ...(mutations.has(action) ? ['apply'] : [])], additionalProperties: false },
 annotations: { readOnlyHint: ['check', 'status', 'logs'].includes(action), destructiveHint: ['cancel', 'down'].includes(action), openWorldHint: ['delegate', 'resume', 'doctor', 'models'].includes(action) },
}));
const server = new Server({ name: 'pi-bridge', version: '0.4.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
 try {
  const tool = tools.find(item => item.name === request.params.name);
  if (!tool) throw new Error('Unknown tool');
  const action = tool.name.slice('pi_bridge_'.length);
  const args = request.params.arguments || {};
  if (typeof args.instance !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(args.instance)) throw new Error('Supply a valid unique chat instance');
  const backend = args.backend || context.backend;
  const callContext = identity(["--instance", args.instance, "--state-root", context.root, "--backend", backend]);
  for (const key of tool.inputSchema.required) if (!(key in args)) throw new Error(`Missing ${key}`);
  for (const key of Object.keys(args)) if (!(key in tool.inputSchema.properties)) throw new Error(`Unknown argument ${key}`);
  if (mutations.has(action) && args.apply !== true) throw new Error('apply:true is required');
  for (const key of ['taskId', 'directory']) if (key in args && (typeof args[key] !== 'string' || !args[key].trim())) throw new Error(`${key} must be a nonempty string`);
  if ('tail' in args && (!Number.isInteger(args.tail) || args.tail < 1 || args.tail > 100)) throw new Error('tail must be an integer from 1 to 100');
  if (action === 'authorize' && !isAbsolute(args.directory)) throw new Error('directory must be absolute');
  let result;
  if (action === 'check') {
    result = { code: 0, data: { backend: callContext.backend, executable: callContext.backend === "dsh" ? resolveDshCli() : resolvePiCli(), node: process.version, platform: process.platform, instance: callContext.instance, home: callContext.home, modelRequestMade: false } };
  } else {
    const command = [action, '--json'];
    let input;
    if (action === 'authorize') command.push('--dir', args.directory);
    if (action === 'delegate') { parseTaskRequest(args.task); command.push('--task-file', '-', '--detach'); input = JSON.stringify(args.task); }
    if (action === 'status') command.push(...(args.taskId ? ['--task', args.taskId] : ['--all']));
    if (['logs', 'cancel', 'resume'].includes(action)) command.push('--task', args.taskId);
    if (action === 'logs') command.push('--tail', String(args.tail || 20));
    result = await runCli(callContext.home, command, input, callContext.backend);
  }
  const output = redactText(JSON.stringify({ instance: callContext.instance, backend: callContext.backend, ...result.data }));
  return { content: [{ type: 'text', text: output.length > 48000 ? JSON.stringify({ instance: callContext.instance, truncated: true, message: 'Response exceeds limit; use task status or a smaller log tail.' }) : output }], isError: result.code !== 0 };
 } catch (err) { return { content: [{ type: 'text', text: redactText(err.message) }], isError: true }; }
});
await server.connect(new StdioServerTransport());
// MCP disconnection leaves the instance daemon/worker available for reconnect.
// Use an explicit --instance value to reconnect to that same isolated state.
