import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig, defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { publicConfig, renameDevice } from '../src/config-admin.js';
import { parseConfigText, serializeConfig, type ConfigFormat } from '../src/config-format.js';
import { migrateConfiguration } from '../src/config-migration.js';

const fakeKey = 'synthetic-v08-config-secret-never-a-real-key';
const batchDefaults = { maxFiles: 20, maxTotalBytes: 4194304 };
const stdinDefaults = { stdinMaxBytes: 65536, stdinMaxTotalBytes: 1048576, stdinWriteTimeoutMs: 5000 };
const batchCustom = { maxFiles: 7, maxTotalBytes: 2097152 };
const stdinCustom = { stdinMaxBytes: 2048, stdinMaxTotalBytes: 32768, stdinWriteTimeoutMs: 1250 };

async function fixture(t: TestContext, format: ConfigFormat = 'json') {
  const parent = await realpath(tmpdir()), folder = await mkdtemp(path.join(parent, 'webcodex-v08-config-'));
  const root = path.join(folder, '项目 with spaces');
  await mkdir(root);
  const configPath = path.join(folder, 'config.' + format);
  const raw = defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic v0.8 config device' });
  raw.tunnel.apiKey = fakeKey;
  const write = async (value: unknown) => writeFile(configPath, (format === 'toml' ? '# synthetic owner comment\n' : '') + serializeConfig(value, format));
  await write(raw);
  t.after(async () => {
    const resolved = await realpath(folder);
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('webcodex-v08-config-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return { root, folder, configPath, format, raw, write };
}

function selectStdin(execution: { stdinMaxBytes?: number; stdinMaxTotalBytes?: number; stdinWriteTimeoutMs?: number }) {
  return { stdinMaxBytes: execution.stdinMaxBytes, stdinMaxTotalBytes: execution.stdinMaxTotalBytes, stdinWriteTimeoutMs: execution.stdinWriteTimeoutMs };
}

for (const format of ['json', 'toml'] as const) {
  test(`${format} v0.8 defaults and partial limits preserve disabled execution and do not open state`, async t => {
    const f = await fixture(t, format);
    assert.deepEqual(f.raw.fileBatches, batchDefaults); assert.deepEqual(selectStdin(f.raw.execution), stdinDefaults);
    const { fileBatches: _batch, ...withoutBatch } = f.raw;
    const { stdinMaxBytes: _single, stdinMaxTotalBytes: _total, stdinWriteTimeoutMs: _timeout, ...execution } = withoutBatch.execution;
    await f.write({ ...withoutBatch, execution });
    const defaults = await loadConfig(f.configPath);
    assert.deepEqual(defaults.fileBatches, batchDefaults); assert.deepEqual(selectStdin(defaults.execution), stdinDefaults);
    assert.equal(defaults.execution.mode, 'disabled'); assert.equal(defaults.tunnel!.apiKey, fakeKey);
    await f.write({ ...withoutBatch, fileBatches: { maxFiles: 3 }, execution: { ...execution, stdinMaxBytes: 32 } });
    const partial = await loadConfig(f.configPath);
    assert.deepEqual(partial.fileBatches, { ...batchDefaults, maxFiles: 3 });
    assert.deepEqual(selectStdin(partial.execution), { ...stdinDefaults, stdinMaxBytes: 32 });
    await assert.rejects(lstat(partial.stateDir), { code: 'ENOENT' });
  });

  test(`${format} v0.8 custom limits survive private administration and appear without secrets in public configuration`, async t => {
    const f = await fixture(t, format);
    await f.write({ ...f.raw, fileBatches: batchCustom, execution: { ...f.raw.execution, ...stdinCustom } });
    const before = await loadConfig(f.configPath);
    await renameDevice(f.configPath, 'Renamed synthetic v0.8 device');
    const after = await loadConfig(f.configPath), visible = publicConfig(after);
    assert.deepEqual(after.fileBatches, batchCustom); assert.deepEqual(selectStdin(after.execution), stdinCustom);
    assert.deepEqual(after.execution, before.execution); assert.equal(after.device!.id, before.device!.id);
    assert.equal(after.workspaces[0].uid, before.workspaces[0].uid); assert.equal(after.tunnel!.apiKey, fakeKey);
    assert.deepEqual(visible.file_batches, batchCustom);
    assert.equal(visible.execution.stdin_max_bytes, stdinCustom.stdinMaxBytes);
    assert.equal(visible.execution.stdin_max_total_bytes, stdinCustom.stdinMaxTotalBytes);
    assert.equal(visible.execution.stdin_write_timeout_ms, stdinCustom.stdinWriteTimeoutMs);
    assert.equal(JSON.stringify(visible).includes(fakeKey), false);
    if (format === 'toml') assert.match(await readFile(f.configPath, 'utf8'), /^# synthetic owner comment/);
    await assert.rejects(lstat(after.stateDir), { code: 'ENOENT' });
  });

  test(`${format} v0.8 rejects invalid batch and stdin limits without disclosing input`, async t => {
    const f = await fixture(t, format);
    const invalidValues: Array<[string, unknown]> = [
      ['single write exceeds per-job input', { ...f.raw, execution: { ...f.raw.execution, stdinMaxBytes: 2048, stdinMaxTotalBytes: 1024 } }],
      ...[
        ['maxFiles', 0], ['maxFiles', 101], ['maxFiles', 1.5], ['maxFiles', true],
        ['maxTotalBytes', 1023], ['maxTotalBytes', 33554433], ['maxTotalBytes', 'synthetic-invalid-secret'],
        ['unrecognized-secret-setting', 'synthetic-invalid-secret'],
      ].map(([field, value]) => [String(field) + '=' + String(value), { ...f.raw, fileBatches: { ...batchDefaults, [String(field)]: value } }] as [string, unknown]),
      ...[
        ['stdinMaxBytes', 0], ['stdinMaxBytes', 1048577], ['stdinMaxBytes', 1.5], ['stdinMaxBytes', true],
        ['stdinMaxTotalBytes', 0], ['stdinMaxTotalBytes', 16777217], ['stdinMaxTotalBytes', false],
        ['stdinWriteTimeoutMs', 99], ['stdinWriteTimeoutMs', 20001], ['stdinWriteTimeoutMs', 100.5],
        ['stdinWriteTimeoutMs', 'synthetic-invalid-secret'],
      ].map(([field, value]) => [String(field) + '=' + String(value), { ...f.raw, execution: { ...f.raw.execution, [String(field)]: value } }] as [string, unknown]),
    ];
    for (const [label, value] of invalidValues) {
      await f.write(value);
      await assert.rejects(loadConfig(f.configPath), error => {
        assert.equal((error as { code: string }).code, 'CONFIG_ERROR', label);
        assert.doesNotMatch(String(error) + JSON.stringify(error), /synthetic-invalid-secret|unrecognized-secret-setting|synthetic-v08-config-secret/);
        return true;
      }, label);
    }
    for (const limits of [
      { batch: { maxFiles: 1, maxTotalBytes: 1024 }, stdin: { stdinMaxBytes: 1, stdinMaxTotalBytes: 1, stdinWriteTimeoutMs: 100 } },
      { batch: { maxFiles: 100, maxTotalBytes: 33554432 }, stdin: { stdinMaxBytes: 1048576, stdinMaxTotalBytes: 16777216, stdinWriteTimeoutMs: 20000 } },
    ]) {
      await f.write({ ...f.raw, fileBatches: limits.batch, execution: { ...f.raw.execution, ...limits.stdin } });
      const loaded = await loadConfig(f.configPath);
      assert.deepEqual(loaded.fileBatches, limits.batch); assert.deepEqual(selectStdin(loaded.execution), limits.stdin);
      assert.equal(loaded.execution.mode, 'disabled');
    }
  });

  test(`${format} migration preserves v0.8 limits and identities across formats with a complete private backup`, async t => {
    const f = await fixture(t, format);
    const configured = { ...f.raw, fileBatches: batchCustom, execution: { ...f.raw.execution, ...stdinCustom, env: { CI: 'true' } } };
    await f.write(configured);
    const original = await readFile(f.configPath), outputFormat = format === 'json' ? 'toml' : 'json';
    const output = path.join(f.folder, 'migrated.' + outputFormat);
    const preview = await migrateConfiguration({ source: f.configPath, output });
    assert.equal(preview.applied, false); assert.equal(preview.identities_provisional, false);
    assert.equal(JSON.stringify(preview).includes(fakeKey), false);
    await assert.rejects(lstat(output), { code: 'ENOENT' }); await assert.rejects(lstat(path.join(f.folder, 'state')), { code: 'ENOENT' });
    const applied = await migrateConfiguration({ source: f.configPath, output, apply: true });
    assert.equal(applied.applied, true); assert.ok('backup_directory' in applied);
    const loaded = await loadConfig(output), rawOutput = parseConfigText(await readFile(output, 'utf8'), outputFormat) as typeof configured;
    assert.deepEqual(loaded.fileBatches, batchCustom); assert.deepEqual(selectStdin(loaded.execution), stdinCustom);
    assert.deepEqual(rawOutput.fileBatches, batchCustom); assert.deepEqual(selectStdin(rawOutput.execution), stdinCustom);
    assert.deepEqual(loaded.execution.env, { CI: 'true' }); assert.equal(loaded.execution.mode, 'disabled');
    assert.equal(loaded.device!.id, f.raw.device.id); assert.equal(loaded.workspaces[0].uid, f.raw.workspaces[0].uid);
    assert.equal(loaded.tunnel!.apiKey, fakeKey); assert.equal(JSON.stringify(applied).includes(fakeKey), false);
    assert.deepEqual(await readFile(f.configPath), original);
    assert.deepEqual(await readFile(path.join(String(applied.backup_directory), 'config.' + format)), original);
    await assert.rejects(lstat(path.join(loaded.stateDir, 'webcodex.sqlite')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(loaded.stateDir, 'owner.sqlite')), { code: 'ENOENT' });
  });
}

test('legacy v1 keeps its schema and migration supplies v0.8 limits without enabling execution', async t => {
  const f = await fixture(t), legacy = defaultConfig(f.root, f.configPath), output = path.join(f.folder, 'legacy-migrated.toml');
  await f.write(legacy);
  const before = await loadConfig(f.configPath);
  assert.equal(before.version, 1); assert.equal(before.fileBatches, undefined); assert.equal(before.execution.stdinMaxBytes, undefined);
  assert.deepEqual(publicConfig(before).file_batches, batchDefaults);
  assert.equal(publicConfig(before).execution.stdin_max_bytes, stdinDefaults.stdinMaxBytes);
  await f.write({ ...legacy, fileBatches: batchDefaults });
  await assert.rejects(loadConfig(f.configPath), { code: 'CONFIG_ERROR' });
  await f.write({ ...legacy, execution: { ...legacy.execution, ...stdinDefaults } });
  await assert.rejects(loadConfig(f.configPath), { code: 'CONFIG_ERROR' });
  await f.write(legacy);
  const applied = await migrateConfiguration({ source: f.configPath, output, apply: true });
  assert.equal(applied.applied, true);
  const loaded = await loadConfig(output);
  assert.equal(loaded.version, 2); assert.deepEqual(loaded.fileBatches, batchDefaults);
  assert.deepEqual(selectStdin(loaded.execution), stdinDefaults); assert.equal(loaded.execution.mode, 'disabled');
});
