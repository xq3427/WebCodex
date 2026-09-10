import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { App } from '../src/app.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { startHttp } from '../src/http.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const marker = 'sk-proj-' + 'S'.repeat(80);
const rootGuidance = 'Root guidance. Verify current tests. ' + '中文😀'.repeat(80);
const nestedGuidance = 'Nested override. Use the configured Node executable.';

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-v07-mcp-'));
  const root = path.join(base, '项目 with spaces'), other = path.join(base, 'other');
  await Promise.all([mkdir(path.join(root, 'src'), { recursive: true }), mkdir(other)]);
  const configPath = path.join(base, 'config.json');
  const raw = defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic emergency device' });
  const config = { ...raw, execution: { ...raw.execution, mode: 'trusted-host', defaultWaitMs: 100, maxWaitMs: 2000 },
    workspaces: [...raw.workspaces, { id: 'other', uid: randomUUID(), root: other, name: 'Other', readOnly: false }] };
  await Promise.all([
    writeFile(configPath, JSON.stringify(config)),
    writeFile(path.join(base, 'AGENTS.md'), 'Outside workspace: must not be included.'),
    writeFile(path.join(root, 'AGENTS.md'), rootGuidance),
    writeFile(path.join(root, 'src', 'AGENTS.md'), 'Overridden: must not be included.'),
    writeFile(path.join(root, 'src', 'AGENTS.override.md'), nestedGuidance),
    writeFile(path.join(root, 'src', 'app.js'), 'process.exit(7);\n'),
  ]);
  t.after(async () => {
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-v07-mcp-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { root, base, configPath, raw, config: await loadConfig(configPath) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function data(value: any): any { assert.equal(value.isError, undefined, JSON.stringify(value)); assert.equal(value.structuredContent?.ok, true); return value.structuredContent.data; }
const errorCode = (value: any) => { assert.equal(value.isError, true); return value.structuredContent.error.code; };

async function connect(f: Fixture, transport: 'stdio' | 'http') {
  const client = new Client({ name: 'v07-integration', version: '1' });
  if (transport === 'stdio') {
    const pipe = new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--config', f.configPath], stderr: 'pipe' });
    pipe.stderr?.on('data', () => {});
    await client.connect(pipe);
    return { client, close: () => client.close() };
  }
  const app = new App(f.config), token = randomUUID() + randomUUID();
  const listener = await startHttp(app, { token, port: 0 });
  await client.connect(new StreamableHTTPClientTransport(new URL(listener.url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  return { client, close: async () => { await client.close(); await listener.close(); await app.close(); } };
}

async function workflow(client: Client, f: Fixture) {
  const call = (name: string, input: Record<string, unknown> = {}) => client.callTool({ name, arguments: input });
  const device = data(await call('system_status')).device_id;
  assert.equal(device, f.raw.device.id);
  const ws = { workspace_id: 'default' }, owner = { ...ws, expected_device_id: device };
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 44);
  for (const name of ['workspace_context', 'task_list', 'task_read', 'exec_wait', 'exec_tail']) assert.equal(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, true);
  for (const name of ['task_create', 'task_checkpoint', 'task_export']) {
    const tool = tools.find(tool => tool.name === name)!;
    assert.equal(tool.annotations?.readOnlyHint, false); assert.equal(tool.annotations?.idempotentHint, true);
    assert.ok(tool.inputSchema.required?.includes('expected_device_id'));
  }
  assert.equal(tools.find(tool => tool.name === 'task_export')?.annotations?.destructiveHint, true);
  let contextCursor: string | undefined;
  const guidance = new Map<string, string>();
  do {
    const page = data(await call('workspace_context', { ...ws, path: 'src/app.js', max_bytes: 256, ...(contextCursor ? { cursor: contextCursor } : {}) }));
    assert.equal(page.scan_complete, true); assert.deepEqual(page.omissions, []);
    for (const item of page.guidance) {
      const prior = guidance.get(item.source) ?? '';
      assert.equal(item.chunk.offset_bytes, Buffer.byteLength(prior));
      guidance.set(item.source, prior + item.content);
    }
    contextCursor = page.next_cursor ?? undefined;
  } while (contextCursor);
  assert.deepEqual([...guidance], [['AGENTS.md', rootGuidance], ['src/AGENTS.override.md', nestedGuidance]]);

  const input = { ...owner, title: 'Emergency task A', objective: 'Implement requested behavior ' + '中文😀'.repeat(200) + marker,
    progress: 'Read project guidance', next_steps: 'Edit and run the program', tracked_paths: ['src/app.js'], idempotency_key: 'create-a' };
  assert.equal(errorCode(await call('task_create', { ...input, expected_device_id: randomUUID() })), 'DEVICE_MISMATCH');
  const a = data(await call('task_create', input));
  assert.equal(a.revision, 1); assert.ok(a.redactions > 0);
  const b = data(await call('task_create', { ...owner, title: 'Independent task B', objective: 'Review later', progress: 'Not started', next_steps: 'Inspect requirements', idempotency_key: 'create-b' }));
  assert.notEqual(a.task_id, b.task_id);
  const pinned = data(await call('task_read', { ...ws, task_id: a.task_id, max_bytes: 256 }));
  assert.equal(pinned.revision, 1); assert.ok(pinned.next_cursor); assert.equal(pinned.freshness.verification_validity, 'unknown');
  const file = data(await call('fs_read', { ...ws, path: 'src/app.js' }));
  const source = "process.stdout.write('验证成功😀\\n');process.stderr.write('diagnostic tail\\n');\n";
  const edit = data(await call('fs_write', { ...owner, path: 'src/app.js', content: source, expected_sha256: file.sha256, idempotency_key: 'edit-program' }));
  const job = data(await call('exec_start', { ...owner, executable: 'node', args: ['src/app.js'], idempotency_key: 'run-program' }));
  let cursor = 0, final: any, output = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    const observed = data(await call('exec_wait', { ...ws, job_id: job.job_id, cursor, wait_ms: 500 }));
    output += observed.output.map((chunk: any) => chunk.text).join(''); cursor = observed.next_cursor;
    if (observed.terminal && !observed.has_more) { final = observed; break; }
  }
  assert.equal(final?.status, 'succeeded'); assert.equal(final.exit_code, 0); assert.match(output, /验证成功😀/);
  const tail = data(await call('exec_tail', { ...ws, job_id: job.job_id, stream: 'stderr', max_bytes: 5 }));
  assert.equal(tail.output.map((chunk: any) => chunk.text).join(''), 'tail\n');
  assert.equal(tail.earlier_output_omitted, true); assert.equal(tail.other_streams_omitted, true);
  assert.equal(data(await call('exec_poll', { ...ws, job_id: job.job_id, cursor: tail.next_cursor })).output.length, 0);

  const checkpoint = { ...owner, task_id: a.task_id, expected_revision: 1, objective: 'Requested behavior implemented', progress: 'Changed app.js and observed exit 0',
    next_steps: 'Review and return to Codex', verification_notes: 'The selected job ran src/app.js; this is not a test suite.', tracked_paths: ['src/app.js'], job_ids: [job.job_id], status: 'paused', idempotency_key: 'checkpoint-a' };
  assert.equal(errorCode(await call('task_checkpoint', { ...checkpoint, expected_device_id: randomUUID() })), 'DEVICE_MISMATCH');
  assert.equal(data(await call('task_checkpoint', checkpoint)).revision, 2);
  assert.equal(errorCode(await call('task_checkpoint', { ...checkpoint, idempotency_key: 'stale-checkpoint' })), 'TASK_REVISION_CONFLICT');
  let content = pinned.content, next = pinned.next_cursor;
  while (next) {
    const page = data(await call('task_read', { ...ws, task_id: a.task_id, cursor: next, max_bytes: 257 }));
    assert.equal(page.revision, 1); assert.equal(page.freshness, null); assert.equal(page.chunk.offset_bytes, Buffer.byteLength(content));
    content += page.content; next = page.next_cursor;
  }
  assert.equal(hash(content), pinned.sha256); assert.equal(content.includes(marker), false);
  assert.equal(JSON.parse(content).notes.progress, input.progress);
  assert.equal(data(await call('task_read', { ...ws, task_id: a.task_id, revision: 1 })).freshness.state, 'changed');
  const current = data(await call('task_read', { ...ws, task_id: a.task_id }));
  assert.equal(current.revision, 2); assert.equal(current.freshness.state, 'unchanged');
  assert.equal(current.freshness.verification_validity, 'unknown');
  const revision = JSON.parse(current.content);
  assert.equal(revision.observations.tracked_files[0].sha256, edit.sha256);
  assert.equal(revision.observations.selected_webcodex_jobs[0].exit_code, 0);
  assert.equal('args' in revision.observations.selected_webcodex_jobs[0], false);
  assert.equal(data(await call('task_read', { ...ws, task_id: b.task_id })).revision, 1);
  assert.equal(errorCode(await call('task_read', { workspace_id: 'other', task_id: a.task_id })), 'TASK_NOT_FOUND');
  const firstList = data(await call('task_list', { ...ws, limit: 1 }));
  assert.equal(firstList.tasks.length, 1); assert.equal(firstList.next_offset, 1);
  assert.equal(data(await call('task_list', { ...ws, limit: 1, offset: firstList.next_offset })).next_offset, null);
  const exportInput = { ...owner, task_id: a.task_id, revision: 2, expected_sha256: null, idempotency_key: 'export-a' };
  assert.equal(errorCode(await call('task_export', { ...exportInput, expected_device_id: randomUUID() })), 'DEVICE_MISMATCH');
  const exported = data(await call('task_export', exportInput));
  const handoff = await readFile(path.join(f.root, 'WEBCODEX_HANDOFF.md'), 'utf8');
  assert.match(handoff, new RegExp(a.task_id)); assert.match(handoff, /Revision: 2/); assert.match(handoff, /"exit_code": 0/);
  assert.equal(hash(handoff), exported.sha256);
  assert.equal(errorCode(await call('task_export', { ...exportInput, idempotency_key: 'conflicting-export' })), 'VERSION_CONFLICT');
  assert.equal(data(await call('task_list', ws)).tasks.length, 2);
  return { a: a.task_id, b: b.task_id, input, checkpoint, exportInput, exported, pinnedCursor: pinned.next_cursor };
}

for (const transport of ['stdio', 'http'] as const) test(`v0.7 ${transport} emergency workflow integrates guidance, independent tasks, execution and restart persistence`, async t => {
  const f = await fixture(t), first = await connect(f, transport);
  let saved: Awaited<ReturnType<typeof workflow>>;
  try { saved = await workflow(first.client, f); } finally { await first.close(); }
  const resumed = await connect(f, transport);
  try {
    const call = (name: string, input: Record<string, unknown>) => resumed.client.callTool({ name, arguments: input });
    assert.equal(data(await call('task_create', saved.input)).task_id, saved.a);
    assert.equal(data(await call('task_checkpoint', saved.checkpoint)).revision, 2);
    assert.equal(data(await call('task_read', { workspace_id: 'default', task_id: saved.b })).revision, 1);
    assert.equal(data(await call('task_export', saved.exportInput)).change_id, saved.exported.change_id);
    assert.equal(errorCode(await call('task_read', { workspace_id: 'default', task_id: saved.a, cursor: saved.pinnedCursor })), 'INVALID_CURSOR');
    assert.equal(data(await call('task_list', { workspace_id: 'default' })).tasks.length, 2);
  } finally { await resumed.close(); }
});
