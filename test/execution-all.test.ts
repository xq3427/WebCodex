import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '../src/app.js';
import { configSchema, defaultConfig } from '../src/config.js';
import { effectiveWorkspaceExecution, publicWorkspaceExecution } from '../src/execution-profiles.js';
import { JobService } from '../src/jobs.js';
import { WorkspacePaths } from '../src/paths.js';
import { createMcpServer } from '../src/server.js';
import { StateStore } from '../src/store.js';
import type { AppConfig, ServiceContext } from '../src/types.js';

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-execution-all-'));
  const root = path.join(base, 'workspace');
  await mkdir(root);
  const configPath = path.join(base, 'config.json');
  const defaults = defaultConfig(root, configPath);
  const config: AppConfig = { ...defaults, configPath, execution: {
    ...defaults.execution, mode: 'trusted-host', commandPolicy: 'all', allowedExecutables: {}, maxTimeoutMs: 10000,
  } };
  const store = new StateStore(config.stateDir);
  const ctx: ServiceContext = { config, store, paths: new WorkspacePaths(config) };
  const jobs = new JobService(ctx);
  t.after(async () => {
    try { await jobs.close(); } finally { store.close(); }
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-execution-all-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { config, jobs, root, store };
}

async function ended(jobs: JobService, jobId: string) {
  let cursor = 0;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await jobs.wait({ workspace_id: 'default', job_id: jobId, cursor, wait_ms: 200 });
    cursor = result.next_cursor;
    if (result.terminal) return jobs.poll({ workspace_id: 'default', job_id: jobId });
  }
  throw new Error('Synthetic program failed to finish.');
}
const output = (result: Awaited<ReturnType<typeof ended>>) => result.output.map(chunk => chunk.text).join('');

test('all runs an unregistered absolute native program with literal arguments and deduplicates its receipt', async t => {
  const f = await fixture(t);
  const marker = 'space & ; $(this-is-literal) | %PATH% !name! "quoted" 中文';
  const input = { workspace_id: 'default', executable: process.execPath,
    args: ['-e', 'console.log(JSON.stringify({value:process.argv[1],cwd:process.cwd()}))', '--', marker], idempotency_key: 'native-path' };
  const job = await f.jobs.start(input);
  const result = await ended(f.jobs, job.job_id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.exit_code, 0);
  assert.deepEqual(JSON.parse(output(result)), { value: marker, cwd: f.root });
  const audit = f.store.db.prepare("SELECT details FROM audit_events WHERE event='exec.start'").get();
  assert.equal(JSON.parse(String(audit!.details)).command, path.resolve(input.executable));
  assert.equal((await f.jobs.start(input)).job_id, job.job_id);
  assert.equal(f.jobs.list({ workspace_id: 'default' }).jobs.length, 1);
});

test('all resolves native program names from absolute PATH entries and workspace profiles only select environment and presets', async t => {
  const f = await fixture(t);
  f.config.execution.env = { NODE_ENV: 'production' };
  f.config.execution.allowedExecutables = { preset: { command: process.execPath, args: ['-e', 'console.log(process.argv[1])', '--', 'fixed-prefix'] } };
  f.config.execution.profiles = { empty: { allowedExecutables: {}, env: { NODE_ENV: 'test' } } };
  f.config.workspaces[0].executionProfile = 'empty';
  const previous = process.env.PATH;
  process.env.PATH = ['', '.', path.dirname(process.execPath)].join(path.delimiter);
  try {
    const job = await f.jobs.start({ workspace_id: 'default', executable: path.basename(process.execPath), args: ['-e', 'console.log(process.env.NODE_ENV)'], idempotency_key: 'native-name' });
    assert.equal(output(await ended(f.jobs, job.job_id)).trim(), 'test');
    const preset = await f.jobs.start({ workspace_id: 'default', executable: 'preset', idempotency_key: 'global-preset' });
    assert.equal(output(await ended(f.jobs, preset.job_id)).trim(), 'fixed-prefix');
    assert.equal(publicWorkspaceExecution(f.config, 'default').command_policy, 'all');
    assert.equal(effectiveWorkspaceExecution(f.config, 'default').profile, 'empty');
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
  }
});

test('all does not bypass global disablement or a read-only workspace and old configurations stay allowlisted', async t => {
  const f = await fixture(t);
  const input = { workspace_id: 'default', executable: process.execPath, args: ['-e', 'process.exit(0)'], idempotency_key: 'blocked' };
  f.config.execution.mode = 'disabled';
  await assert.rejects(f.jobs.start(input), { code: 'EXECUTION_DISABLED' });
  f.config.execution.mode = 'trusted-host';
  f.config.workspaces[0].readOnly = true;
  await assert.rejects(f.jobs.start(input), { code: 'READ_ONLY' });
  f.config.workspaces[0].readOnly = false;
  delete f.config.execution.commandPolicy;
  assert.equal(effectiveWorkspaceExecution(f.config, 'default').commandPolicy, 'allowlist');
  await assert.rejects(f.jobs.start(input), { code: 'EXECUTABLE_NOT_ALLOWED' });
  const original = defaultConfig(f.root, f.config.configPath);
  assert.equal(configSchema.parse(original).execution.commandPolicy, 'allowlist');
  assert.equal(configSchema.safeParse({ ...original, execution: { ...original.execution, commandPolicy: 'unknown' } }).success, false);
  assert.equal(f.jobs.list({ workspace_id: 'default' }).jobs.length, 0);
});

test('all refuses implicit shells, relative program paths and cwd-dependent PATH lookup', async t => {
  const f = await fixture(t);
  for (const executable of ['./node', 'node -e text', 'node;echo', 'npm.cmd', path.join(f.root, 'script.bat'), 'node\0']) {
    await assert.rejects(f.jobs.start({ workspace_id: 'default', executable, idempotency_key: 'invalid-' + executable.replace(/\0/g, '') }), { code: 'INVALID_EXECUTABLE' });
  }
  const previous = process.env.PATH;
  process.env.PATH = path.delimiter + '.' + path.delimiter + 'relative-directory';
  try {
    await assert.rejects(f.jobs.start({ workspace_id: 'default', executable: path.basename(process.execPath), idempotency_key: 'no-cwd-search' }), { code: 'EXECUTABLE_NOT_FOUND' });
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
  }
  assert.equal(f.jobs.list({ workspace_id: 'default' }).jobs.length, 0);
});

test('changing command policy cannot reinterpret an existing start or stdin receipt', async t => {
  const f = await fixture(t);
  f.config.execution.allowedExecutables = { node: process.execPath };
  f.config.execution.commandPolicy = 'allowlist';
  const input = { workspace_id: 'default', executable: 'node', args: ['-e', 'process.stdin.resume()'], stdin: 'pipe' as const, idempotency_key: 'policy-bound' };
  const job = await f.jobs.start(input);
  f.config.execution.commandPolicy = 'all';
  await assert.rejects(f.jobs.start(input), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.jobs.writeStdin({ workspace_id: 'default', job_id: job.job_id, end: true, idempotency_key: 'wrong-policy' }), { code: 'EXECUTION_PROFILE_CHANGED' });
  f.config.execution.commandPolicy = 'allowlist';
  await f.jobs.writeStdin({ workspace_id: 'default', job_id: job.job_id, end: true, idempotency_key: 'finish-original' });
  assert.equal((await ended(f.jobs, job.job_id)).exit_code, 0);
  f.config.execution.commandPolicy = 'all';
  const next = await f.jobs.start({ ...input, stdin: 'closed', args: ['-e', 'process.exit(0)'], idempotency_key: 'all-bound' });
  await ended(f.jobs, next.job_id);
  f.config.execution.commandPolicy = 'allowlist';
  await assert.rejects(f.jobs.start({ ...input, stdin: 'closed', args: ['-e', 'process.exit(0)'], idempotency_key: 'all-bound' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('all retains concurrency and actual timeout enforcement', async t => {
  const f = await fixture(t);
  f.config.execution.maxConcurrent = 1;
  const input = { workspace_id: 'default', executable: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(0),5000)'], idempotency_key: 'timeout', timeout_ms: 1000 };
  await assert.rejects(f.jobs.start({ ...input, timeout_ms: 10001 }), { code: 'INVALID_ARGUMENT' });
  const job = await f.jobs.start(input);
  await assert.rejects(f.jobs.start({ ...input, idempotency_key: 'concurrency' }), { code: 'CONCURRENCY_LIMIT' });
  const finished = await ended(f.jobs, job.job_id);
  assert.equal(finished.status, 'timed_out', JSON.stringify(finished));
});

test('all preserves a selected executable symlink entry instead of substituting its base binary', async t => {
  const f = await fixture(t);
  const entry = path.join(f.root, process.platform === 'win32' ? 'environment-node.exe' : 'environment-node');
  try { await symlink(process.execPath, entry, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Windows file-symlink privilege unavailable; selected symlink entry behavior remains for POSIX CI.');
      return;
    }
    throw error;
  }
  assert.notEqual(await realpath(entry), path.resolve(entry));
  const job = await f.jobs.start({ workspace_id: 'default', executable: entry, args: ['-e', 'console.log("selected-entry")'], idempotency_key: 'symlink-entry' });
  assert.equal(output(await ended(f.jobs, job.job_id)).trim(), 'selected-entry');
  const starts = f.store.db.prepare("SELECT details FROM audit_events WHERE event='exec.start'").all();
  assert.equal(starts.length, 1);
  assert.equal(JSON.parse(String(starts[0].details)).command, path.resolve(entry));
});

test('the public MCP exec_start schema accepts an unregistered absolute native path', async t => {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-execution-mcp-'));
  const root = path.join(base, 'workspace');
  await mkdir(root);
  const configPath = path.join(base, 'config.json');
  const defaults = defaultConfig(root, configPath);
  const config: AppConfig = { ...defaults, configPath, execution: { ...defaults.execution, mode: 'trusted-host', commandPolicy: 'all', allowedExecutables: {} } };
  const app = new App(config);
  const server = createMcpServer(app);
  const client = new Client({ name: 'execution-all-public-test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = await client.callTool({ name: 'exec_start', arguments: {
      workspace_id: 'default', executable: process.execPath, args: ['-e', 'console.log("public-native-path")'], idempotency_key: 'public-path',
    } });
    assert.notEqual(call.isError, true, JSON.stringify(call));
    const result = call.structuredContent as { ok: boolean; data: { job_id: string } };
    assert.equal(result.ok, true);
    const finished = await ended(app.jobs, result.data.job_id);
    assert.equal(finished.exit_code, 0);
    assert.equal(output(finished).trim(), 'public-native-path');
  } finally {
    await client.close();
    await server.close();
    await app.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-execution-mcp-'));
    await rm(actual, { recursive: true, force: true });
  }
});

test('Windows MCP exec_start can copy original bytes using an explicit cmd command with Chinese and spaced paths', { skip: process.platform !== 'win32' }, async () => {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-execution-mcp-'));
  const root = path.join(base, '中文 工作区');
  await mkdir(root);
  const configPath = path.join(base, 'config.json');
  const defaults = defaultConfig(root, configPath);
  const config: AppConfig = { ...defaults, configPath, execution: { ...defaults.execution, mode: 'trusted-host', commandPolicy: 'all', allowedExecutables: {} } };
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.ok(systemRoot && path.win32.isAbsolute(systemRoot));
  config.execution.allowedExecutables = { cmdPreset: { command: path.win32.join(systemRoot, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c'] } };
  const app = new App(config);
  const server = createMcpServer(app);
  const client = new Client({ name: 'execution-cmd-copy-test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const source = path.join(root, '原始 & 文件.pdf');
  const bytes = Buffer.concat([Buffer.from('%PDF synthetic binary copy test\n'), Buffer.from([0, 255, 13, 10, 26, 128])]);
  try {
    await writeFile(source, bytes, { flag: 'wx' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const form of ['separate-args', 'command-string', 'explicit-s', 'preset'] as const) {
      const target = path.join(root, '已复制 & ' + form + '.pdf');
      const command = `copy /b "${source}" "${target}"`;
      const args = form === 'separate-args' ? ['/d', '/c', 'copy', '/b', source, target]
        : form === 'explicit-s' ? ['/d', '/s', '/c', command]
          : form === 'preset' ? [command] : ['/d', '/c', command];
      const executable = form === 'preset' ? 'cmdPreset' : 'cmd.exe';
      const call = await client.callTool({ name: 'exec_start', arguments: {
        workspace_id: 'default', executable, args, idempotency_key: 'cmd-copy-' + form,
      } });
      assert.notEqual(call.isError, true, JSON.stringify(call));
      const result = call.structuredContent as { ok: boolean; data: { job_id: string } };
      assert.equal(result.ok, true);
      const finished = await ended(app.jobs, result.data.job_id);
      assert.equal(finished.exit_code, 0, form + ': ' + output(finished));
      assert.deepEqual(await readFile(target), bytes, form + ' must preserve original bytes including EOF and non-text bytes');
      const repeated = await client.callTool({ name: 'exec_start', arguments: {
        workspace_id: 'default', executable, args, idempotency_key: 'cmd-copy-' + form,
      } });
      assert.equal((repeated.structuredContent as typeof result).data.job_id, result.data.job_id);
    }
  } finally {
    await client.close();
    await server.close();
    await app.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-execution-mcp-'));
    await rm(actual, { recursive: true, force: true });
  }
});
