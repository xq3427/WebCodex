import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, realpath, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig, defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { serializeConfig, type ConfigFormat } from '../src/config-format.js';

const widgetDefaults = { fileWidgetTicketTtlMs: 300000, fileWidgetCacheMaxBytes: 33554432, fileWidgetChunkMaxBytes: 65536 };
const behaviorDefaults = { mode: 'automatic', compact: true, closeAfterSend: true };
const secret = 'synthetic-widget-config-private-value';

async function fixture(t: TestContext, format: ConfigFormat) {
  const parent = await realpath(tmpdir()), folder = await mkdtemp(path.join(parent, 'webcodex-widget-config-'));
  const root = path.join(folder, '项目 with spaces');
  await mkdir(root);
  const configPath = path.join(folder, 'config.' + format);
  const raw = defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic widget config device' });
  raw.tunnel.apiKey = secret;
  const write = async (value: unknown) => writeFile(configPath, serializeConfig(value, format));
  t.after(async () => {
    const actual = await realpath(folder);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-widget-config-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { root, folder, configPath, raw, write };
}

for (const format of ['json', 'toml'] as const) {
  test(`${format} old v1/v2 configuration defaults to automatic file delivery without rewriting or opening state`, async t => {
    const f = await fixture(t, format);
    for (const raw of [defaultConfig(f.root, f.configPath), f.raw]) {
      assert.deepEqual(raw.fileWidget, behaviorDefaults);
      const legacy: Record<string, unknown> = { ...raw };
      delete legacy.fileWidget;
      for (const document of [legacy, { ...legacy, fileWidget: {} }, raw]) {
        await f.write(document);
        const original = await readFile(f.configPath), loaded = await loadConfig(f.configPath);
        assert.deepEqual(loaded.fileWidget, behaviorDefaults);
        assert.equal(loaded.execution.mode, 'disabled');
        assert.deepEqual(await readFile(f.configPath), original);
        await assert.rejects(lstat(loaded.stateDir), { code: 'ENOENT' });
      }
    }
  });

  test(`${format} file widget manual and display settings round trip with independent defaults`, async t => {
    const f = await fixture(t, format);
    const partials = [
      { mode: 'manual' }, { compact: false }, { closeAfterSend: false },
      { mode: 'automatic', compact: false, closeAfterSend: false },
      { mode: 'manual', compact: false, closeAfterSend: false },
    ];
    for (const raw of [defaultConfig(f.root, f.configPath), f.raw]) {
      for (const fileWidget of partials) {
        await f.write({ ...raw, fileWidget });
        const loaded = await loadConfig(f.configPath);
        assert.deepEqual(loaded.fileWidget, { ...behaviorDefaults, ...fileWidget });
        assert.equal(loaded.limits.fileTransferMaxBytes, undefined);
        assert.equal(loaded.limits.fileWidgetUploadMaxBytes, undefined);
        assert.equal(loaded.execution.mode, 'disabled');
        if (loaded.version === 2) {
          assert.equal(loaded.device!.id, f.raw.device.id);
          assert.equal(loaded.tunnel!.apiKey, secret);
        }
        await assert.rejects(lstat(loaded.stateDir), { code: 'ENOENT' });
      }
    }
  });

  test(`${format} file widget behavior strictly rejects unsupported modes, types and keys`, async t => {
    const f = await fixture(t, format);
    const cases: unknown[] = [
      'synthetic-invalid-secret', true, 1, [],
      { mode: 'auto' }, { mode: 'AUTOMATIC' }, { mode: '' }, { mode: true }, { mode: 1 },
      { compact: 'false' }, { compact: 0 }, { compact: [] },
      { closeAfterSend: 'true' }, { closeAfterSend: 1 }, { closeAfterSend: {} },
      { ...behaviorDefaults, 'synthetic-unknown-widget-secret': true },
    ];
    if (format === 'json') cases.push(null, { mode: null }, { compact: null }, { closeAfterSend: null });
    for (const raw of [defaultConfig(f.root, f.configPath), f.raw]) {
      for (const fileWidget of cases) {
        await f.write({ ...raw, fileWidget });
        await assert.rejects(loadConfig(f.configPath), error => {
          assert.equal((error as { code: string }).code, 'CONFIG_ERROR');
          assert.doesNotMatch(String(error) + JSON.stringify(error), /synthetic-invalid-secret|synthetic-unknown-widget-secret|synthetic-widget-config-private-value/);
          return true;
        });
      }
    }
  });

  test(`${format} old configuration leaves optional widget transport limits for runtime defaults without rewriting or opening state`, async t => {
    const f = await fixture(t, format);
    for (const raw of [defaultConfig(f.root, f.configPath), f.raw]) {
      await f.write(raw);
      const original = await readFile(f.configPath), loaded = await loadConfig(f.configPath);
      assert.equal(loaded.limits.fileWidgetTicketTtlMs, undefined);
      assert.equal(loaded.limits.fileWidgetCacheMaxBytes, undefined);
      assert.equal(loaded.limits.fileWidgetChunkMaxBytes, undefined);
      assert.equal(loaded.execution.mode, 'disabled');
      assert.deepEqual(await readFile(f.configPath), original);
      await assert.rejects(lstat(loaded.stateDir), { code: 'ENOENT' });
    }
    await f.write({ ...f.raw, limits: { ...f.raw.limits, fileWidgetTicketTtlMs: 45000 } });
    const partial = await loadConfig(f.configPath);
    assert.equal(partial.limits.fileWidgetTicketTtlMs, 45000);
    assert.equal(partial.limits.fileWidgetCacheMaxBytes, undefined);
    assert.equal(partial.limits.fileWidgetChunkMaxBytes, undefined);
    assert.equal(partial.device!.id, f.raw.device.id);
    assert.equal(partial.tunnel!.apiKey, secret);
  });

  test(`${format} widget transport settings accept defaults and inclusive bounds independently of original-file limits`, async t => {
    const f = await fixture(t, format);
    const cases = [
      widgetDefaults,
      { fileWidgetTicketTtlMs: 1000, fileWidgetCacheMaxBytes: 1, fileWidgetChunkMaxBytes: 4096 },
      { fileWidgetTicketTtlMs: 1800000, fileWidgetCacheMaxBytes: 268435456, fileWidgetChunkMaxBytes: 262144 },
    ];
    for (const version of [1, 2] as const) {
      const raw = version === 1 ? defaultConfig(f.root, f.configPath) : f.raw;
      for (const limits of cases) {
        await f.write({ ...raw, limits: { ...raw.limits, ...limits, fileTransferMaxBytes: 1024, fileWidgetUploadMaxBytes: 104857600 } });
        const loaded = await loadConfig(f.configPath);
        assert.equal(loaded.version, version);
        for (const field of Object.keys(limits) as Array<keyof typeof widgetDefaults>) assert.equal(loaded.limits[field], limits[field]);
        assert.equal(loaded.limits.fileTransferMaxBytes, 1024);
        assert.equal(loaded.limits.fileWidgetUploadMaxBytes, 104857600);
        assert.equal(loaded.limits.readMaxBytes, raw.limits.readMaxBytes);
        assert.equal(loaded.limits.writeMaxBytes, raw.limits.writeMaxBytes);
        assert.equal(loaded.execution.mode, 'disabled');
        await assert.rejects(lstat(loaded.stateDir), { code: 'ENOENT' });
      }
    }
  });

  test(`${format} widget transport settings reject out-of-range and non-integer inputs without disclosing configuration`, async t => {
    const f = await fixture(t, format);
    const cases: Array<[string, unknown]> = [
      ['fileWidgetTicketTtlMs', 999], ['fileWidgetTicketTtlMs', 1800001], ['fileWidgetTicketTtlMs', 1000.5],
      ['fileWidgetTicketTtlMs', 'synthetic-invalid-secret'], ['fileWidgetTicketTtlMs', false],
      ['fileWidgetCacheMaxBytes', 0], ['fileWidgetCacheMaxBytes', 268435457], ['fileWidgetCacheMaxBytes', 1.5],
      ['fileWidgetCacheMaxBytes', 'synthetic-invalid-secret'], ['fileWidgetCacheMaxBytes', true],
      ['fileWidgetChunkMaxBytes', 4095], ['fileWidgetChunkMaxBytes', 262145], ['fileWidgetChunkMaxBytes', 4096.5],
      ['fileWidgetChunkMaxBytes', 'synthetic-invalid-secret'], ['fileWidgetChunkMaxBytes', false],
      ['synthetic-unknown-widget-secret', 123],
    ];
    // TOML has no null value; JSON must not treat explicit null as omission.
    if (format === 'json') for (const field of Object.keys(widgetDefaults)) cases.push([field, null]);
    for (const [field, value] of cases) {
      await f.write({ ...f.raw, limits: { ...f.raw.limits, ...widgetDefaults, [field]: value } });
      await assert.rejects(loadConfig(f.configPath), error => {
        assert.equal((error as { code: string }).code, 'CONFIG_ERROR', field);
        assert.doesNotMatch(String(error) + JSON.stringify(error), /synthetic-invalid-secret|synthetic-unknown-widget-secret|synthetic-widget-config-private-value/);
        return true;
      }, field);
    }
  });
}
