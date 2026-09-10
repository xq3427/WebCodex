import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { App } from '../src/app.js';
import { defaultConfig, defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { publicConfig, renameDevice } from '../src/config-admin.js';
import { parseConfigText, serializeConfig, type ConfigFormat } from '../src/config-format.js';
import { migrateConfiguration } from '../src/config-migration.js';
import { TaskService } from '../src/tasks.js';

const fakeKey = 'synthetic-v07-config-secret-never-a-real-key';
const taskDefaults = { maxTasksPerWorkspace: 100, maxRevisionsPerTask: 100, maxTrackedFiles: 20, maxSnapshotBytes: 16777216 };
const contextDefaults = { maxDepth: 32, maxFileBytes: 65536, maxTotalBytes: 262144 };
const taskCustom = { maxTasksPerWorkspace: 250, maxRevisionsPerTask: 175, maxTrackedFiles: 35, maxSnapshotBytes: 2097152 };
const contextCustom = { maxDepth: 12, maxFileBytes: 32768, maxTotalBytes: 131072 };

async function fixture(t: TestContext, format: ConfigFormat = 'json') {
  const parent = await realpath(tmpdir()), folder = await mkdtemp(path.join(parent, 'webcodex-v07-config-'));
  const root = path.join(folder, '项目 with spaces');
  await mkdir(root);
  const configPath = path.join(folder, 'config.' + format);
  const raw = defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic v0.7 config device' });
  raw.tunnel.apiKey = fakeKey;
  const write = async (value: unknown) => writeFile(configPath, (format === 'toml' ? '# synthetic owner comment\n' : '') + serializeConfig(value, format));
  await write(raw);
  t.after(async () => {
    const resolved = await realpath(folder);
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('webcodex-v07-config-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return { root, folder, configPath, format, raw, write };
}

for (const format of ['json', 'toml'] as const) {
  test(`${format} v0.7 omitted sections and partial sections load bounded defaults without enabling execution`, async t => {
    const f = await fixture(t, format);
    assert.deepEqual(f.raw.tasks, taskDefaults); assert.deepEqual(f.raw.projectContext, contextDefaults);
    assert.equal(f.raw.execution.defaultWaitMs, 1000); assert.equal(f.raw.execution.maxWaitMs, 20000);
    const { tasks: _tasks, projectContext: _context, ...withoutSections } = f.raw;
    const { defaultWaitMs: _wait, maxWaitMs: _maxWait, ...execution } = withoutSections.execution;
    await f.write({ ...withoutSections, execution });
    const defaults = await loadConfig(f.configPath);
    assert.deepEqual(defaults.tasks, taskDefaults); assert.deepEqual(defaults.projectContext, contextDefaults);
    assert.equal(defaults.execution.defaultWaitMs, 1000); assert.equal(defaults.execution.maxWaitMs, 20000);
    assert.equal(defaults.execution.mode, 'disabled');
    assert.equal(defaults.tunnel!.apiKey, fakeKey);
    await f.write({ ...withoutSections, execution: { ...execution, defaultWaitMs: 0 }, tasks: { maxTrackedFiles: 3 }, projectContext: { maxDepth: 4 } });
    const partial = await loadConfig(f.configPath);
    assert.deepEqual(partial.tasks, { ...taskDefaults, maxTrackedFiles: 3 });
    assert.deepEqual(partial.projectContext, { ...contextDefaults, maxDepth: 4 });
    assert.equal(partial.execution.defaultWaitMs, 0); assert.equal(partial.execution.maxWaitMs, 20000);
    await assert.rejects(lstat(defaults.stateDir), { code: 'ENOENT' });
  });

  test(`${format} v0.7 custom values survive private administration and appear in redacted public configuration`, async t => {
    const f = await fixture(t, format);
    const configured = { ...f.raw, tasks: taskCustom, projectContext: contextCustom, execution: { ...f.raw.execution, defaultWaitMs: 450, maxWaitMs: 4500, env: { CI: 'true', PYTHONUTF8: '1' } } };
    await f.write(configured);
    const before = await loadConfig(f.configPath);
    assert.deepEqual(before.tasks, taskCustom); assert.deepEqual(before.projectContext, contextCustom);
    assert.equal(before.execution.defaultWaitMs, 450); assert.equal(before.execution.maxWaitMs, 4500);
    await renameDevice(f.configPath, 'Renamed synthetic device');
    const after = await loadConfig(f.configPath);
    assert.deepEqual(after.tasks, taskCustom); assert.deepEqual(after.projectContext, contextCustom);
    assert.deepEqual(after.execution, before.execution); assert.equal(after.device!.id, before.device!.id);
    assert.equal(after.workspaces[0].uid, before.workspaces[0].uid); assert.equal(after.tunnel!.apiKey, fakeKey);
    const visible = publicConfig(after);
    assert.deepEqual(visible.tasks, taskCustom); assert.deepEqual(visible.project_context, contextCustom);
    assert.equal(visible.execution.default_wait_ms, 450); assert.equal(visible.execution.max_wait_ms, 4500);
    assert.equal(JSON.stringify(visible).includes(fakeKey), false);
    if (format === 'toml') assert.match(await readFile(f.configPath, 'utf8'), /^# synthetic owner comment/);
    await assert.rejects(lstat(after.stateDir), { code: 'ENOENT' });
  });

  test(`${format} v0.7 validates wait ordering, guidance aggregate bounds and strict task counts`, async t => {
    const f = await fixture(t, format);
    const invalidValues: Array<[string, unknown]> = [
      ['wait exceeds maximum', { ...f.raw, execution: { ...f.raw.execution, defaultWaitMs: 1001, maxWaitMs: 1000 } }],
      ['wait too large', { ...f.raw, execution: { ...f.raw.execution, defaultWaitMs: 20001 } }],
      ['maximum wait too large', { ...f.raw, execution: { ...f.raw.execution, maxWaitMs: 20001 } }],
      ['negative wait', { ...f.raw, execution: { ...f.raw.execution, defaultWaitMs: -1 } }],
      ['zero maximum wait', { ...f.raw, execution: { ...f.raw.execution, maxWaitMs: 0 } }],
      ['fractional wait', { ...f.raw, execution: { ...f.raw.execution, defaultWaitMs: 1.5 } }],
      ['string wait', { ...f.raw, execution: { ...f.raw.execution, defaultWaitMs: 'synthetic-invalid-secret' } }],
      ['guidance file exceeds total', { ...f.raw, projectContext: { ...contextDefaults, maxFileBytes: 2048, maxTotalBytes: 1024 } }],
      ...[
        ['maxTasksPerWorkspace', 0], ['maxTasksPerWorkspace', 10001], ['maxTasksPerWorkspace', 2.5],
        ['maxRevisionsPerTask', 0], ['maxRevisionsPerTask', 10001], ['maxTrackedFiles', 0], ['maxTrackedFiles', 101],
        ['maxTrackedFiles', true], ['maxSnapshotBytes', 1023], ['maxSnapshotBytes', 134217729],
        ['unrecognized-secret-setting', 'synthetic-invalid-secret'],
      ].map(([field, value]) => [String(field) + '=' + String(value), { ...f.raw, tasks: { ...taskDefaults, [String(field)]: value } }] as [string, unknown]),
      ...[
        ['maxDepth', 0], ['maxDepth', 129], ['maxDepth', 1.5], ['maxFileBytes', 1023], ['maxFileBytes', 1048577],
        ['maxTotalBytes', 1023], ['maxTotalBytes', 4194305], ['maxTotalBytes', false], ['unrecognized-secret-setting', 'synthetic-invalid-secret'],
      ].map(([field, value]) => [String(field) + '=' + String(value), { ...f.raw, projectContext: { ...contextDefaults, [String(field)]: value } }] as [string, unknown]),
    ];
    for (const [label, value] of invalidValues) {
      await f.write(value);
      await assert.rejects(loadConfig(f.configPath), error => {
        assert.equal((error as { code: string }).code, 'CONFIG_ERROR', label);
        assert.doesNotMatch(String(error) + JSON.stringify(error), /synthetic-invalid-secret|unrecognized-secret-setting|synthetic-v07-config-secret/);
        return true;
      }, label);
    }
    const extremes = [
      { tasks: { maxTasksPerWorkspace: 1, maxRevisionsPerTask: 1, maxTrackedFiles: 1, maxSnapshotBytes: 1024 }, projectContext: { maxDepth: 1, maxFileBytes: 1024, maxTotalBytes: 1024 }, waits: { defaultWaitMs: 0, maxWaitMs: 1 } },
      { tasks: { maxTasksPerWorkspace: 10000, maxRevisionsPerTask: 10000, maxTrackedFiles: 100, maxSnapshotBytes: 134217728 }, projectContext: { maxDepth: 128, maxFileBytes: 1048576, maxTotalBytes: 4194304 }, waits: { defaultWaitMs: 20000, maxWaitMs: 20000 } },
    ];
    for (const limits of extremes) {
      await f.write({ ...f.raw, tasks: limits.tasks, projectContext: limits.projectContext, execution: { ...f.raw.execution, ...limits.waits } });
      const loaded = await loadConfig(f.configPath);
      assert.deepEqual(loaded.tasks, limits.tasks); assert.deepEqual(loaded.projectContext, limits.projectContext);
      assert.equal(loaded.execution.defaultWaitMs, limits.waits.defaultWaitMs); assert.equal(loaded.execution.maxWaitMs, limits.waits.maxWaitMs);
      assert.equal(loaded.execution.mode, 'disabled');
    }
  });

  test(`${format} migration to the other format preserves v0.7 settings, identities and complete private source backup`, async t => {
    const f = await fixture(t, format);
    const configured = { ...f.raw, tasks: taskCustom, projectContext: contextCustom, execution: { ...f.raw.execution, defaultWaitMs: 777, maxWaitMs: 7777, env: { CI: 'true' } } };
    await f.write(configured);
    const original = await readFile(f.configPath), outputFormat = format === 'json' ? 'toml' : 'json';
    const output = path.join(f.folder, 'migrated.' + outputFormat);
    const preview = await migrateConfiguration({ source: f.configPath, output });
    assert.equal(preview.applied, false); assert.equal(preview.identities_provisional, false);
    assert.equal(JSON.stringify(preview).includes(fakeKey), false);
    await assert.rejects(lstat(output), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(f.folder, 'state')), { code: 'ENOENT' });
    const applied = await migrateConfiguration({ source: f.configPath, output, apply: true });
    assert.equal(applied.applied, true); assert.ok('backup_directory' in applied);
    const loaded = await loadConfig(output), rawOutput = parseConfigText(await readFile(output, 'utf8'), outputFormat) as typeof configured;
    assert.deepEqual(loaded.tasks, taskCustom); assert.deepEqual(loaded.projectContext, contextCustom);
    assert.deepEqual(rawOutput.tasks, taskCustom); assert.deepEqual(rawOutput.projectContext, contextCustom);
    assert.equal(loaded.execution.defaultWaitMs, 777); assert.equal(loaded.execution.maxWaitMs, 7777);
    assert.deepEqual(loaded.execution.env, { CI: 'true' }); assert.equal(loaded.execution.mode, 'disabled');
    assert.equal(loaded.device!.id, f.raw.device.id); assert.equal(loaded.workspaces[0].uid, f.raw.workspaces[0].uid);
    assert.equal(loaded.tunnel!.apiKey, fakeKey); assert.equal(JSON.stringify(applied).includes(fakeKey), false);
    assert.deepEqual(await readFile(f.configPath), original);
    assert.deepEqual(await readFile(path.join(String(applied.backup_directory), 'config.' + format)), original);
    await assert.rejects(lstat(path.join(loaded.stateDir, 'webcodex.sqlite')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(loaded.stateDir, 'owner.sqlite')), { code: 'ENOENT' });
  });
}

test('legacy v1 migration supplies v0.7 defaults while keeping execution disabled', async t => {
  const f = await fixture(t), legacy = defaultConfig(f.root, f.configPath), output = path.join(f.folder, 'legacy-migrated.toml');
  await f.write(legacy);
  const applied = await migrateConfiguration({ source: f.configPath, output, apply: true });
  assert.equal(applied.applied, true);
  const loaded = await loadConfig(output);
  assert.equal(loaded.version, 2); assert.deepEqual(loaded.tasks, taskDefaults); assert.deepEqual(loaded.projectContext, contextDefaults);
  assert.equal(loaded.execution.defaultWaitMs, 1000); assert.equal(loaded.execution.maxWaitMs, 20000); assert.equal(loaded.execution.mode, 'disabled');
});

test('task_list with 256-byte text pages preserves a complete 256-byte title including JSON-escaped characters', async t => {
  const f = await fixture(t);
  f.raw.limits.readMaxBytes = 256;
  await f.write(f.raw);
  const app = new App(await loadConfig(f.configPath));
  try {
    const tasks = new TaskService(app.ctx, app.files, app.git);
    const title = '"'.repeat(256);
    const task = await tasks.create({ workspace_id: 'default', title, objective: 'Check list boundaries', progress: 'Prepared', next_steps: 'Read the task list', idempotency_key: 'escaped-title' });
    const listed = await tasks.list({ workspace_id: 'default', limit: 1 });
    assert.equal(listed.tasks.length, 1); assert.equal(listed.tasks[0].task_id, task.task_id); assert.equal(listed.tasks[0].title, title);
    assert.equal(listed.next_offset, null);
    assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= 2048, 'One bounded summary must not require an unbounded response.');
  } finally { await app.close(); }
});
