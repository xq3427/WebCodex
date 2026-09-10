import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defaultUnifiedConfig, loadConfig, validateConfig } from '../src/config.js';
import { parseConfigText, serializeConfig, type ConfigFormat } from '../src/config-format.js';
import { WorkspacePaths } from '../src/paths.js';
import type { AppConfig } from '../src/types.js';
import type { WorkspaceInput } from '../src/workspace-config.js';

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const SYNTHETIC_SECRET = 'synthetic-workspace-config-secret-never-print';

async function fixture(t: TestContext, format: ConfigFormat = 'json') {
  const temporaryRoot = await realpath(tmpdir());
  const temp = await realpath(await mkdtemp(path.join(temporaryRoot, 'webcodex-shorthand-')));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)), temporaryRoot);
    assert.match(path.basename(temp), /^webcodex-shorthand-/);
    await rm(temp, { recursive: true, force: true });
  });
  const first = path.join(temp, '项目 A');
  const second = path.join(temp, '论文');
  const third = path.join(temp, 'third project');
  const replacement = path.join(temp, '目标项目');
  await Promise.all([first, second, third, replacement].map(root => mkdir(root)));
  const configPath = path.join(temp, 'config.' + format);
  const defaults = defaultUnifiedConfig(first, configPath, { deviceName: 'Workspace fixture device' });
  const raw = { ...defaults, workspaces: [first, second] as WorkspaceInput[] };
  raw.tunnel.apiKey = SYNTHETIC_SECRET;
  const write = async (value: unknown = raw) => {
    const source = (format === 'toml' ? '# owner workspace settings\n' : '') + serializeConfig(value, format);
    await writeFile(configPath, source);
    return source;
  };
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[name]) env[name] = process.env[name];
  const cli = async (...args: string[]) => {
    const result = await run(process.execPath, [cliPath, ...args, '--config', configPath], { cwd: temp, env, windowsHide: true });
    assert.ok(!(result.stdout + result.stderr).includes(SYNTHETIC_SECRET));
    return JSON.parse(result.stdout) as Record<string, any>;
  };
  return { temp, first, second, third, replacement, configPath, raw, defaults, format, write, cli };
}

const identities = (config: AppConfig) => Object.fromEntries(config.workspaces.map(workspace => [workspace.root, { id: workspace.id, uid: workspace.uid }]));

for (const format of ['json', 'toml'] as const) {
  test(`${format} path-array workspaces load without rewriting configuration or creating state`, async t => {
    const f = await fixture(t, format);
    const original = await f.write();
    const first = await loadConfig(f.configPath);
    const again = await loadConfig(f.configPath);
    assert.deepEqual(first.workspaces.map(workspace => workspace.root), [f.first, f.second]);
    assert.deepEqual(first.workspaces.map(workspace => workspace.name), ['项目 A', '论文']);
    assert.ok(first.workspaces.every(workspace => workspace.readOnly === false));
    for (const workspace of first.workspaces) {
      assert.match(workspace.id, /^[a-zA-Z0-9_-]{1,64}$/);
      assert.match(workspace.uid!, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    }
    assert.notEqual(first.workspaces[0].uid, first.workspaces[1].uid);
    assert.deepEqual(identities(first), identities(again));
    assert.equal(await readFile(f.configPath, 'utf8'), original);
    assert.deepEqual((parseConfigText(original, format) as { workspaces: unknown }).workspaces, [f.first, f.second]);
    await assert.rejects(lstat(path.join(f.temp, 'state')), { code: 'ENOENT' });
  });

  test(`${format} mixes path strings, root-only objects and existing explicit workspace identities`, async t => {
    const f = await fixture(t, format);
    const explicit = { ...f.defaults.workspaces[0], id: 'existing_project', name: 'Stable existing name', root: f.third };
    f.raw.workspaces = [f.first, { root: f.second, readOnly: true }, explicit, { root: f.replacement }];
    await f.write();
    const loaded = await loadConfig(f.configPath);
    assert.deepEqual(loaded.workspaces.map(workspace => workspace.root), [f.first, f.second, f.third, f.replacement]);
    assert.deepEqual(loaded.workspaces[2], explicit);
    assert.equal(loaded.workspaces[3].name, '目标项目');
    assert.equal(loaded.workspaces[3].readOnly, false);
    const paths = new WorkspacePaths(loaded);
    await assert.rejects(paths.resolve(loaded.workspaces[1].id, 'new.txt', { write: true, allowMissing: true }), { code: 'READ_ONLY' });
    assert.equal(await paths.resolve(loaded.workspaces[0].id, 'new.txt', { write: true, allowMissing: true }), path.join(f.first, 'new.txt'));
  });
}

test('generated workspace identities survive reordering, spelling changes and display names', async t => {
  const f = await fixture(t);
  const first = await validateConfig(f.raw, f.configPath);
  const relativeFirst = path.relative(f.temp, f.first).split(path.sep).join('/');
  const relativeSecond = path.relative(f.temp, f.second).split(path.sep).join('/');
  const variants: WorkspaceInput[][] = [
    [f.second, f.first],
    [{ root: relativeSecond, name: 'New display name' }, { root: './' + relativeFirst }],
    ['${configDir}/' + relativeFirst, '${configDir}/' + relativeSecond],
    [process.platform === 'win32' ? f.first.toUpperCase() : f.first, f.second + path.sep],
  ];
  for (const workspaces of variants) {
    const loaded = await validateConfig({ ...f.raw, workspaces }, f.configPath);
    assert.deepEqual(identities(loaded), identities(first));
  }
});

test('generated workspace identities belong to the device while explicit identities remain unchanged', async t => {
  const f = await fixture(t);
  const explicit = { ...f.defaults.workspaces[0], root: f.third };
  const raw = { ...f.raw, workspaces: [f.first, explicit] };
  const original = await validateConfig(raw, f.configPath);
  const renamed = await validateConfig({ ...raw, device: { ...raw.device, name: 'Renamed device', id: raw.device.id.toUpperCase() } }, f.configPath);
  assert.deepEqual(identities(renamed), identities(original));
  const other = await validateConfig({ ...raw, device: { ...raw.device, id: randomUUID() } }, f.configPath);
  assert.notEqual(other.workspaces[0].id, original.workspaces[0].id);
  assert.notEqual(other.workspaces[0].uid, original.workspaces[0].uid);
  assert.equal(other.workspaces[1].id, explicit.id);
  assert.equal(other.workspaces[1].uid, explicit.uid);
});

test('workspace shorthand still rejects duplicate roots, malformed entries and protected directories', async t => {
  const f = await fixture(t);
  const invalid: unknown[] = [
    [], [f.first, f.first],
    [f.first, { root: path.relative(f.temp, f.first), id: 'different_name', uid: randomUUID() }],
    [''], [null], [{ root: [f.first, f.second] }],
    [path.join(f.temp, 'missing-project')], [{ root: f.first, readOnly: 'yes' }],
    [{ root: f.first, unexpected: SYNTHETIC_SECRET }],
  ];
  for (const workspaces of invalid) {
    await assert.rejects(validateConfig({ ...f.raw, workspaces }, f.configPath), (error: unknown) => {
      const failure = error as { code?: string; message?: string };
      assert.equal(failure.code, 'CONFIG_ERROR');
      assert.ok(!String(failure.message).includes(SYNTHETIC_SECRET));
      return true;
    });
  }
  const protectedRoot = path.join(f.temp, '.ssh');
  await mkdir(protectedRoot);
  await assert.rejects(validateConfig({ ...f.raw, workspaces: [protectedRoot] }, f.configPath), { code: 'PATH_DENIED' });
});

for (const format of ['json', 'toml'] as const) {
  test(`${format} CLI can add, remove and rebind shorthand workspaces by their listed IDs`, async t => {
    const f = await fixture(t, format);
    await f.write();
    await writeFile(path.join(f.first, 'keep.txt'), 'Removing a registration keeps project files.');
    const listed = await f.cli('workspace', 'list');
    const initial = await loadConfig(f.configPath);
    assert.equal(listed.workspaces[0].workspace_id, initial.workspaces[0].id);
    assert.equal(listed.workspaces[1].workspace_id, initial.workspaces[1].id);
    await f.cli('workspace', 'add', '--id', 'added', '--root', f.third, '--name', 'Added project', '--read-only');
    const added = await loadConfig(f.configPath);
    assert.deepEqual(added.workspaces.slice(0, 2), initial.workspaces);
    assert.equal(added.workspaces[2].readOnly, true);
    await f.cli('workspace', 'remove', '--id', initial.workspaces[0].id);
    assert.equal(await readFile(path.join(f.first, 'keep.txt'), 'utf8'), 'Removing a registration keeps project files.');
    await f.cli('workspace', 'rebind', '--id', initial.workspaces[1].id, '--root', f.replacement, '--name', 'Rebound project');
    const rebound = await loadConfig(f.configPath);
    assert.equal(rebound.workspaces[0].id, initial.workspaces[1].id);
    assert.notEqual(rebound.workspaces[0].uid, initial.workspaces[1].uid);
    assert.equal(rebound.workspaces[0].root, f.replacement);
    assert.equal(rebound.workspaces[0].name, 'Rebound project');
    assert.equal(rebound.workspaces[1].uid, added.workspaces[2].uid);
    assert.equal(rebound.tunnel?.apiKey, SYNTHETIC_SECRET);
    assert.equal(rebound.execution.mode, 'disabled');
    if (format === 'toml') assert.ok((await readFile(f.configPath, 'utf8')).includes('# owner workspace settings'));
    assert.ok(!(await readdir(f.temp)).some(name => name.endsWith('.lock') || name.startsWith('.webcodex-write-config-')));
  });

  test(`${format} CLI repairs a missing shorthand root using its prior generated workspace ID`, async t => {
    const f = await fixture(t, format);
    // Both supported compact shapes must remain addressable after the old root disappears.
    f.raw.workspaces = [format === 'json' ? f.first : { root: path.relative(f.temp, f.first) }, f.second];
    await f.write();
    const original = await loadConfig(f.configPath);
    await rmdir(f.first);
    await assert.rejects(loadConfig(f.configPath), { code: 'CONFIG_ERROR' });
    await f.cli('workspace', 'rebind', '--id', original.workspaces[0].id, '--root', f.replacement, '--read-only');
    const repaired = await loadConfig(f.configPath);
    assert.equal(repaired.workspaces[0].id, original.workspaces[0].id);
    assert.notEqual(repaired.workspaces[0].uid, original.workspaces[0].uid);
    assert.equal(repaired.workspaces[0].root, f.replacement);
    assert.equal(repaired.workspaces[0].readOnly, true);
    assert.deepEqual(repaired.workspaces[1], original.workspaces[1]);
    assert.equal(repaired.device?.id, original.device?.id);
    await f.cli('workspace', 'rebind', '--id', repaired.workspaces[0].id, '--root', f.replacement, '--name', 'Same directory');
    assert.equal((await loadConfig(f.configPath)).workspaces[0].uid, repaired.workspaces[0].uid);
    assert.equal((await loadConfig(f.configPath)).tunnel?.apiKey, SYNTHETIC_SECRET);
  });
}
