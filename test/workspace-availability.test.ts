import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { App } from '../src/app.js';
import { defaultConfig } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-availability-'));
  const a = path.join(base, '项目 A');
  const b = path.join(base, '项目 B');
  await Promise.all([mkdir(a), mkdir(b)]);
  const configPath = path.join(base, 'config.json');
  const defaults = defaultConfig(a, configPath);
  const config: AppConfig = { ...defaults, version: 2, device: { id: randomUUID(), name: 'Availability fixture' }, configPath,
    workspaces: [a, b].map((root, index) => ({ id: index === 0 ? 'a' : 'b', uid: randomUUID(), name: path.basename(root), root, readOnly: false })) };
  let app: App | undefined;
  const close = async () => { const current = app; app = undefined; await current?.close(); };
  const start = () => { assert.equal(app, undefined); app = new App(config); return app; };
  const restart = async () => { await close(); return start(); };
  const move = async (from: string, to: string) => {
    assert.equal(path.dirname(path.resolve(from)), base);
    assert.equal(path.dirname(path.resolve(to)), base);
    assert.equal(await realpath(from), path.resolve(from));
    await rename(from, to);
  };
  t.after(async () => {
    await close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-availability-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { base, a, b, config, get app() { assert.ok(app); return app; }, start, close, restart, move };
}

const row = (app: App, id: string) => app.listWorkspaces().workspaces.find(workspace => workspace.workspace_id === id)!;
const bindingCount = (app: App) => app.store.db.prepare('SELECT COUNT(*) AS n FROM webcodex_workspace_bindings').get()!.n;
const create = (app: App, workspace_id: string, content = 'available') => app.files.write({ workspace_id, path: 'result.txt', content, expected_sha256: null, idempotency_key: 'write' });

test('search rejects a root replaced during scanning instead of returning a misleading empty success', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.a, 'report.txt'), 'match');
  f.start();
  let scanned = false;
  t.mock.method(f.app.files as any, 'runRg', async () => {
    scanned = true;
    await f.move(f.a, path.join(f.base, 'original-a'));
    await mkdir(f.a);
    return { lines: [], truncated: false };
  });
  await assert.rejects(f.app.files.search({ workspace_id: 'a', query: 'match' }), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  assert.equal(scanned, true);
});

for (const operation of ['status', 'diff'] as const) {
  test(`git ${operation} rejects root replacement during result filtering`, async t => {
    const f = await fixture(t);
    const init = spawnSync('git', ['init', '--quiet', f.a], { windowsHide: true });
    assert.equal(init.status, 0);
    await writeFile(path.join(f.a, 'report.txt'), 'original');
    const add = spawnSync('git', ['-C', f.a, 'add', '--', 'report.txt'], { windowsHide: true });
    assert.equal(add.status, 0);
    f.start();
    const original = (f.app.git as any).allowed.bind(f.app.git);
    let replaced = false;
    t.mock.method(f.app.git as any, 'allowed', async (...args: any[]) => {
      if (!replaced) {
        replaced = true;
        await f.move(f.a, path.join(f.base, 'original-a'));
        await mkdir(f.a);
      }
      return original(...args);
    });
    await assert.rejects(operation === 'status' ? f.app.git.status({ workspace_id: 'a' }) : f.app.git.diff({ workspace_id: 'a', staged: true }), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
    assert.equal(replaced, true);
  });
}

test('missing roots fail startup by default and failed initialization releases the state lease', async t => {
  const f = await fixture(t);
  await f.move(f.a, path.join(f.base, 'parked-a'));
  assert.throws(() => f.start(), { code: 'WORKSPACE_UNAVAILABLE' });
  f.config.workspaces[0].onUnavailable = 'skip';
  const app = f.start();
  assert.equal(row(app, 'a').status, 'missing');
  assert.equal(row(app, 'b').status, 'available');
  assert.equal(bindingCount(app), 1);
});

test('skip starts without binding a missing workspace and healthy workspace files remain usable', async t => {
  const f = await fixture(t);
  await f.move(f.a, path.join(f.base, 'parked-a'));
  f.config.workspaces[0].onUnavailable = 'skip';
  const app = f.start();
  const health = app.workspaceHealth({ workspace_id: 'a' });
  assert.equal(health.workspaces.length, 1);
  assert.equal(health.workspaces[0].error_code, 'WORKSPACE_UNAVAILABLE');
  assert.equal(health.workspaces[0].available, false);
  await assert.rejects(app.files.read({ workspace_id: 'a', path: 'result.txt' }), { code: 'WORKSPACE_UNAVAILABLE' });
  await assert.rejects(create(app, 'a'), { code: 'WORKSPACE_UNAVAILABLE' });
  await create(app, 'b');
  assert.equal((await app.files.read({ workspace_id: 'b', path: 'result.txt' })).content, 'available');
  assert.equal(bindingCount(app), 1);
  assert.throws(() => app.workspaceHealth({ workspace_id: 'unknown' }), { code: 'WORKSPACE_NOT_FOUND' });
});

test('a root created after skipped startup requires restart before its first identity binding', async t => {
  const f = await fixture(t);
  await f.move(f.a, path.join(f.base, 'parked-a'));
  f.config.workspaces[0].onUnavailable = 'skip';
  f.start();
  await mkdir(f.a);
  const waiting = row(f.app, 'a');
  assert.equal(waiting.status, 'restart_required');
  assert.equal(waiting.restart_required, true);
  assert.equal(waiting.error_code, 'WORKSPACE_RESTART_REQUIRED');
  await assert.rejects(create(f.app, 'a'), { code: 'WORKSPACE_RESTART_REQUIRED' });
  assert.equal(bindingCount(f.app), 1);
  await f.restart();
  assert.equal(row(f.app, 'a').status, 'available');
  assert.equal(bindingCount(f.app), 2);
  await create(f.app, 'a', 'newly authorized');
  assert.equal(await readFile(path.join(f.a, 'result.txt'), 'utf8'), 'newly authorized');
});

test('an original directory can disappear and return without changing its binding or cached edits', async t => {
  const f = await fixture(t);
  f.start();
  const change = await create(f.app, 'a');
  const binding = f.app.identity.workspaceIdentity('a');
  const fingerprint = f.app.store.db.prepare('SELECT root_fingerprint FROM webcodex_workspace_bindings WHERE binding_id=?').get(binding)!.root_fingerprint;
  const parked = path.join(f.base, 'original-a');
  await f.move(f.a, parked);
  assert.equal(row(f.app, 'a').status, 'missing');
  assert.equal(row(f.app, 'b').available, true);
  await assert.rejects(f.app.openWorkspace({ workspace_id: 'a' }), { code: 'WORKSPACE_UNAVAILABLE' });
  await create(f.app, 'b');
  await f.move(parked, f.a);
  assert.equal(row(f.app, 'a').status, 'available');
  assert.equal(f.app.identity.workspaceIdentity('a'), binding);
  assert.deepEqual(await create(f.app, 'a'), change);
  assert.equal(f.app.store.db.prepare('SELECT root_fingerprint FROM webcodex_workspace_bindings WHERE binding_id=?').get(binding)!.root_fingerprint, fingerprint);
});

test('replacing an active root rejects file access and cannot apply its old backup to the replacement', async t => {
  const f = await fixture(t);
  f.start();
  await writeFile(path.join(f.a, 'result.txt'), 'before');
  const change = await f.app.files.write({ workspace_id: 'a', path: 'result.txt', content: 'after', expected_sha256: sha('before'), idempotency_key: 'original-write' });
  await f.move(f.a, path.join(f.base, 'original-a'));
  await mkdir(f.a);
  await writeFile(path.join(f.a, 'result.txt'), 'after');
  assert.equal(row(f.app, 'a').status, 'identity_mismatch');
  assert.equal(row(f.app, 'a').error_code, 'WORKSPACE_IDENTITY_MISMATCH');
  const operations: Array<() => unknown> = [
    () => f.app.files.list({ workspace_id: 'a', path: '.' }),
    () => f.app.files.read({ workspace_id: 'a', path: 'result.txt' }),
    () => f.app.fileChunks.read({ workspace_id: 'a', path: 'result.txt' }),
    () => create(f.app, 'a'),
    () => f.app.files.mkdir({ workspace_id: 'a', path: 'new-dir', idempotency_key: 'mkdir' }),
    () => f.app.files.changesList({ workspace_id: 'a' }),
    () => f.app.files.restore({ workspace_id: 'a', change_id: change.change_id!, expected_sha256: change.sha256, idempotency_key: 'unsafe-restore' }),
    () => f.app.fileBatches.preview({ workspace_id: 'a', changes: [{ op: 'write' as const, path: 'new.txt', content: 'blocked', expected_sha256: null }] }),
  ];
  for (const operation of operations) await assert.rejects(Promise.resolve().then(operation), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  assert.equal(await readFile(path.join(f.a, 'result.txt'), 'utf8'), 'after');
  await create(f.app, 'b');
  assert.equal((await f.app.files.read({ workspace_id: 'b', path: 'result.txt' })).content, 'available');
});

test('skip does not adopt a replacement directory on restart or overwrite its saved fingerprint', async t => {
  const f = await fixture(t);
  f.config.workspaces[0].onUnavailable = 'skip';
  f.start();
  const binding = f.app.identity.workspaceIdentity('a');
  const before = f.app.store.db.prepare('SELECT * FROM webcodex_workspace_bindings WHERE binding_id=?').get(binding);
  await f.move(f.a, path.join(f.base, 'original-a'));
  await mkdir(f.a);
  await f.restart();
  assert.equal(row(f.app, 'a').status, 'identity_mismatch');
  assert.equal(row(f.app, 'b').available, true);
  await assert.rejects(create(f.app, 'a'), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  assert.deepEqual(f.app.store.db.prepare('SELECT * FROM webcodex_workspace_bindings WHERE binding_id=?').get(binding), before);
  assert.equal(bindingCount(f.app), 2);
});

test('default startup rejects a replaced root; explicit new UID creates an isolated history', async t => {
  const f = await fixture(t);
  f.start();
  const old = await create(f.app, 'a', 'old saved version');
  await f.move(f.a, path.join(f.base, 'original-a'));
  await mkdir(f.a);
  await writeFile(path.join(f.a, 'result.txt'), 'old saved version');
  await assert.rejects(f.restart(), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  f.config.workspaces[0].uid = randomUUID();
  f.start();
  assert.equal(row(f.app, 'a').status, 'available');
  assert.equal((await f.app.files.changesList({ workspace_id: 'a' })).changes.length, 0);
  await assert.rejects(f.app.files.restore({ workspace_id: 'a', change_id: old.change_id!, expected_sha256: old.sha256, idempotency_key: 'wrong-root-restore' }), { code: 'CHANGE_NOT_FOUND' });
  assert.equal(await readFile(path.join(f.a, 'result.txt'), 'utf8'), 'old saved version');
});

test('all-disabled workspaces start without root metadata IO and remain disabled when directories exist', async t => {
  const f = await fixture(t);
  for (const workspace of f.config.workspaces) workspace.enabled = false;
  const original = fs.lstatSync;
  let rootReads = 0;
  const mocked = t.mock.method(fs, 'lstatSync', (...args: any[]) => {
    if (f.config.workspaces.some(workspace => String(args[0]) === workspace.root)) { rootReads++; throw new Error('Disabled root metadata must not be read.'); }
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  try {
    const app = f.start();
    assert.deepEqual(app.listWorkspaces().workspaces.map(workspace => workspace.status), ['disabled', 'disabled']);
    assert.equal(bindingCount(app), 0);
    await assert.rejects(app.files.read({ workspace_id: 'a', path: 'anything.txt' }), { code: 'WORKSPACE_DISABLED' });
    await assert.rejects(create(app, 'b'), { code: 'WORKSPACE_DISABLED' });
    assert.equal(rootReads, 0);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('metadata access errors report one inaccessible workspace while preserving the other workspace', async t => {
  const f = await fixture(t);
  f.start();
  const original = fs.lstatSync;
  const mocked = t.mock.method(fs, 'lstatSync', (...args: any[]) => {
    if (String(args[0]) === f.a) throw Object.assign(new Error('Synthetic denied metadata'), { code: 'EACCES' });
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(row(f.app, 'a').status, 'inaccessible');
    assert.equal(row(f.app, 'a').error_code, 'WORKSPACE_UNAVAILABLE');
    assert.equal(row(f.app, 'b').available, true);
    await assert.rejects(create(f.app, 'a'), { code: 'WORKSPACE_UNAVAILABLE' });
    await create(f.app, 'b');
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(row(f.app, 'a').status, 'available');
});

test('skip startup rejects blocked roots rather than treating arbitrary metadata errors as a missing disk', async t => {
  const f = await fixture(t);
  await f.move(f.a, path.join(f.base, 'original-a'));
  await writeFile(f.a, 'This path is a regular file.');
  f.config.workspaces[0].onUnavailable = 'skip';
  assert.throws(() => f.start(), { code: 'PATH_DENIED' });
  f.config.workspaces[0].enabled = false;
  assert.equal(row(f.start(), 'a').status, 'disabled');
});

for (const batch of [false, true]) {
  test(`${batch ? 'readMany' : 'read'} does not return replacement-root content after initial path authorization`, async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.a, 'report.txt'), 'original project text');
    f.start();
    const resolve = f.app.ctx.paths.resolve.bind(f.app.ctx.paths);
    const replacementText = 'replacement-project-content-must-not-be-returned';
    let replaced = false;
    f.app.ctx.paths.resolve = async (...args) => {
      const result = await resolve(...args);
      if (!replaced && args[0] === 'a' && args[1] === 'report.txt') {
        replaced = true;
        await f.move(f.a, path.join(f.base, 'original-a'));
        await mkdir(f.a);
        await writeFile(path.join(f.a, 'report.txt'), replacementText);
      }
      return result;
    };
    try {
      if (batch) {
        const result = await f.app.files.readMany({ workspace_id: 'a', files: [{ path: 'report.txt' }] });
        assert.equal(result.results.length, 1);
        const entry = result.results[0];
        assert.equal(entry.ok, false);
        if (!entry.ok) assert.equal(entry.error.code, 'WORKSPACE_IDENTITY_MISMATCH');
        assert.equal(result.content_bytes, 0);
        assert.ok(!JSON.stringify(result).includes(replacementText));
      } else {
        await assert.rejects(f.app.files.read({ workspace_id: 'a', path: 'report.txt' }), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
      }
      assert.equal(replaced, true);
      assert.equal(row(f.app, 'a').status, 'identity_mismatch');
    } finally { f.app.ctx.paths.resolve = resolve; }
  });
}
