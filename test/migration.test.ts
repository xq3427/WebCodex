import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultConfig, loadConfig } from '../src/config.js';
import { parseConfigText } from '../src/config-format.js';
import { migrateConfiguration, writePrivateConfig } from '../src/config-migration.js';
import { protectConfigFile } from '../src/config-permissions.js';
import { StateStore } from '../src/store.js';
import { WorkspacePaths } from '../src/paths.js';
import { initializeIdentity } from '../src/identity.js';
import { FileService } from '../src/filesystem.js';

const run = promisify(execFile);
const fakeKey = 'synthetic-migration-key-never-a-real-key';
const fakeToken = 'synthetic-http-bearer-never-a-real-token';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: TestContext, secrets = false) {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-migration-'));
  const root = path.join(base, 'workspace');
  const state = path.join(base, 'state');
  const source = path.join(base, 'config.json');
  const output = path.join(base, 'config.toml');
  const auth = path.join(base, 'private', 'tunnel-auth.json');
  const connect = path.join(base, 'connect.ps1');
  await Promise.all([mkdir(root), mkdir(state), mkdir(path.dirname(auth))]);
  const raw = defaultConfig(root, source);
  await writeFile(source, JSON.stringify(raw, null, 2));
  if (secrets) {
    await writeFile(auth, JSON.stringify({ api_key: fakeKey }));
    await writeFile(connect, "& '.\\scripts\\start-tunnel.ps1' -TunnelId 'tunnel_fixture' -ProxyUrl 'http://127.0.0.1:7890'\n");
    await writeFile(path.join(state, 'http-token'), fakeToken);
  }
  t.after(async () => {
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-migration-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { base, root, state, source, output, auth, connect, raw };
}

async function absent(file: string) { await assert.rejects(lstat(file), { code: 'ENOENT' }); }

test('migration preview imports static sources without writes, code execution or secret output', async t => {
  const f = await fixture(t, true);
  const marker = path.join(f.base, 'must-not-run.txt');
  await writeFile(f.connect, "& '.\\scripts\\start-tunnel.ps1' -TunnelId 'tunnel_fixture'\n" + `Set-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value 'executed'\n`);
  const original = await readFile(f.source);
  const before = await readdir(f.base);
  const result = await migrateConfiguration({ source: f.source, output: f.output });
  assert.equal(result.applied, false);
  assert.equal(result.identities_provisional, true);
  assert.equal(result.api_key_configured, true);
  assert.equal(result.http_token_configured, true);
  assert.deepEqual(result.legacy_sources.sort(), ['auth', 'connection', 'http-token']);
  assert.equal(result.codex_home, null);
  assert.ok(!JSON.stringify(result).includes(fakeKey));
  assert.ok(!JSON.stringify(result).includes(fakeToken));
  assert.deepEqual(await readFile(f.source), original);
  assert.deepEqual(await readdir(f.base), before);
  await absent(f.output); await absent(marker);
  await absent(path.join(f.state, 'private-config-backups'));
});

test('applied migration preserves original private backups and valid JSON/TOML values', async t => {
  const f = await fixture(t, true);
  const original = await readFile(f.source);
  const result = await migrateConfiguration({ source: f.source, output: f.output, apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.identities_provisional, false);
  assert.ok('backup_directory' in result);
  const backup = String(result.backup_directory);
  assert.deepEqual(await readFile(path.join(backup, 'config.json')), original);
  assert.deepEqual(await readFile(path.join(backup, 'auth.backup')), await readFile(f.auth));
  assert.deepEqual(await readFile(path.join(backup, 'connection.backup')), await readFile(f.connect));
  assert.equal(await readFile(path.join(backup, 'http-token.backup'), 'utf8'), fakeToken);
  const config = await loadConfig(f.output);
  assert.equal(config.version, 2);
  assert.equal(config.tunnel?.apiKey, fakeKey);
  assert.equal(config.http.bearerToken, fakeToken);
  assert.equal(config.tunnel?.id, 'tunnel_fixture');
  assert.equal(config.stateDir, f.state);
  assert.equal(config.codexSessions.home, null);
  assert.deepEqual(await readFile(f.source), original);
  assert.ok(!JSON.stringify(result).includes(fakeKey));
  assert.ok(!JSON.stringify(result).includes(fakeToken));
  assert.equal((await lstat(f.output)).nlink, 1);
  await assert.rejects(migrateConfiguration({ source: f.source, output: f.output, apply: true }), { code: 'CONFIG_EXISTS' });
  assert.equal((await readdir(f.base)).some(name => name.startsWith('.webcodex-write-config-') || name.endsWith('.lock')), false);
});

test('in-place JSON migration retains state device, workspace UID and bound change retries', async t => {
  const f = await fixture(t);
  const original = await readFile(f.source);
  const config = await loadConfig(f.source);
  let store = new StateStore(f.state);
  const firstCtx = { config, store, paths: new WorkspacePaths(config) };
  const identity = initializeIdentity(firstCtx).workspaceSource('default');
  const input = { workspace_id: 'default', path: 'example.txt', content: 'retained', expected_sha256: null, idempotency_key: 'migration-retain' };
  const change = await new FileService(firstCtx).write(input);
  store.close();
  const result = await migrateConfiguration({ source: f.source, output: f.source, apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.device_id, identity.device_id);
  assert.equal(result.workspaces[0].workspace_uid, identity.workspace_uid);
  assert.ok('backup_directory' in result);
  assert.deepEqual(await readFile(path.join(String(result.backup_directory), 'config.json')), original);
  const migrated = await loadConfig(f.source);
  store = new StateStore(f.state);
  try {
    const ctx = { config: migrated, store, paths: new WorkspacePaths(migrated) };
    assert.deepEqual(await new FileService(ctx).write(input), change);
  } finally { store.close(); }
});

test('migration rejects dynamic or incomplete legacy connection parameters without printing secrets', async t => {
  const f = await fixture(t, true);
  await writeFile(f.connect, "& '.\\start.ps1' -TunnelId $env:TUNNEL_ID\n");
  await assert.rejects(migrateConfiguration({ source: f.source, output: f.output, apply: true }), error => {
    assert.equal((error as { code: string }).code, 'MIGRATION_CONNECTION_AMBIGUOUS');
    assert.ok(!String(error).includes(fakeKey)); return true;
  });
  await writeFile(f.connect, "# no tunnel ID provided\n");
  await assert.rejects(migrateConfiguration({ source: f.source, output: f.output }), { code: 'MIGRATION_CONNECTION_INCOMPLETE' });
  await absent(f.output);
  await absent(path.join(f.state, 'private-config-backups'));
});

test('legacy launcher accepts only a unique literal ProxyUrl default forwarded once', async t => {
  const f = await fixture(t, true);
  const launcher = (declaration: string, extra = '') => `param(\n  [string]$ProxyUrl = ${declaration},\n  [switch]$DoctorOnly\n)\n${extra}\n& $launcher -TunnelId 'tunnel_fixture' -ProxyUrl $ProxyUrl -DoctorOnly:$DoctorOnly\n`;
  await writeFile(f.connect, launcher("'http://127.0.0.1:7890'"));
  const preview = await migrateConfiguration({ source: f.source, output: f.output });
  assert.equal(preview.proxy_configured, true);
  assert.equal(preview.applied, false);
  await writeFile(f.connect, '#requires -Version 5.1\n[CmdletBinding()]\n' + launcher("'http://127.0.0.1:7890'"));
  assert.equal((await migrateConfiguration({ source: f.source, output: f.output })).proxy_configured, true);
  for (const text of [
    launcher("'http://127.0.0.1:7890'", "$ProxyUrl = 'http://changed.example'"),
    launcher("'http://127.0.0.1:7890' + '/computed'"),
    launcher('"http://$env:PROXY_HOST"'),
    launcher("'http://127.0.0.1:7890'", 'Write-Output $ProxyUrl'),
  ]) {
    await writeFile(f.connect, text);
    await assert.rejects(migrateConfiguration({ source: f.source, output: f.output }), { code: 'MIGRATION_CONNECTION_AMBIGUOUS' });
  }
});

test('private writer publishes complete content exclusively and cleans failures without an empty destination', async t => {
  const f = await fixture(t);
  const target = path.join(f.base, 'new-private.json');
  await assert.rejects(writePrivateConfig(target, { oversized: 'x'.repeat(1024 * 1024) }), { code: 'CONFIG_TOO_LARGE' });
  await absent(target);
  await assert.rejects(writePrivateConfig(target, { secret: fakeKey }, undefined, async () => { throw new Error('injected publication check failure'); }), /injected publication/);
  await absent(target);
  assert.equal((await readdir(f.base)).some(name => name.startsWith('.webcodex-write-config-') || name.endsWith('.lock')), false);
  await assert.rejects(writePrivateConfig(target, { secret: fakeKey }, undefined, async () => { await writeFile(target, '{"competitor":true}'); }), { code: 'CONFIG_EXISTS' });
  assert.equal(await readFile(target, 'utf8'), '{"competitor":true}');
  const before = await readFile(target);
  await assert.rejects(writePrivateConfig(target, { secret: fakeKey }, before, async () => { await writeFile(target, '{"changed":true}'); }), { code: 'CONFIG_CONFLICT' });
  assert.equal(await readFile(target, 'utf8'), '{"changed":true}');
});

test('all imported sources are checked again after backup creation and immediately before publication', async t => {
  for (const kind of ['config', 'auth', 'connection', 'http-token'] as const) {
    for (const change of ['content', 'replacement'] as const) {
      await t.test(`${kind}: ${change} after backups prevents publication`, async child => {
        const f = await fixture(child, true);
        const source = { config: f.source, auth: f.auth, connection: f.connect, 'http-token': path.join(f.state, 'http-token') }[kind];
        const original = await readFile(source);
        let reachedPublication = false;
        await assert.rejects(migrateConfiguration({ source: f.source, output: f.output, apply: true }, async () => {
          reachedPublication = true;
          const backupRoot = path.join(f.state, 'private-config-backups');
          const backups = await readdir(backupRoot);
          assert.equal(backups.length, 1);
          const backup = path.join(backupRoot, backups[0]);
          assert.deepEqual((await readdir(backup)).sort(), ['auth.backup', 'config.json', 'connection.backup', 'http-token.backup']);
          assert.deepEqual(await readFile(path.join(backup, kind === 'config' ? 'config.json' : `${kind}.backup`)), original);
          assert.ok((await readdir(f.base)).some(name => name.startsWith('.webcodex-write-config-')));
          await absent(f.output);
          if (change === 'replacement') {
            // Keep the original inode alive so a same-byte replacement cannot reuse it.
            await rename(source, source + '.replaced');
            await writeFile(source, original);
          } else {
            await writeFile(source, Buffer.concat([original, Buffer.from('\n')]));
          }
        }), { code: 'CONFIG_CONFLICT' });
        assert.equal(reachedPublication, true);
        await absent(f.output);
        assert.deepEqual(await readFile(source), change === 'replacement' ? original : Buffer.concat([original, Buffer.from('\n')]));
        assert.equal((await readdir(f.base)).some(name => name.startsWith('.webcodex-write-config-') || name.endsWith('.lock')), false);
      });
    }
  }
});

test('private file ACL replaces explicit broad grants and permission failures leave no published content', async t => {
  const f = await fixture(t);
  const target = path.join(f.base, "quote's-private.json");
  await writePrivateConfig(target, { secret: fakeKey });
  if (process.platform !== 'win32') {
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT!;
  const system32 = path.join(systemRoot, 'System32');
  await run(path.join(system32, 'icacls.exe'), [target, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
  await protectConfigFile(target);
  const script = `$a=[System.IO.File]::GetAccessControl('${target.replace(/'/g, "''")}');@($a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }) | ConvertTo-Json -Compress`;
  const result = await run(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  assert.equal((JSON.parse(result.stdout) as string[]).includes('S-1-1-0'), false);
  const old = process.env.SystemRoot;
  try {
    process.env.SystemRoot = path.join(f.base, 'nonexistent-system');
    const failedTarget = path.join(f.base, 'permissions-failed.json');
    await assert.rejects(writePrivateConfig(failedTarget, { secret: fakeKey }), { code: 'CONFIG_PERMISSIONS_ERROR' });
    await absent(failedTarget);
    assert.equal((await readdir(f.base)).some(name => name.startsWith('.webcodex-write-config-') || name.endsWith('.lock')), false);
  } finally { if (old === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = old; }
});

test('migration refuses linked source parents and writer rejects a linked output directory', async t => {
  const f = await fixture(t);
  const alias = path.join(f.base, 'linked-project');
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(f.root, 'nested.json'), JSON.stringify(f.raw));
  await assert.rejects(migrateConfiguration({ source: path.join(alias, 'nested.json'), output: f.output }), { code: 'CONFIG_PATH_DENIED' });
  await assert.rejects(writePrivateConfig(path.join(alias, 'private.json'), { secret: fakeKey }), { code: 'CONFIG_PATH_DENIED' });
  await absent(path.join(f.root, 'private.json'));
  const original = await readFile(f.source);
  assert.equal(sha(original), sha(Buffer.from(JSON.stringify(f.raw, null, 2))));
  assert.equal((parseConfigText(original.toString('utf8'), 'json') as { version: number }).version, 1);
});
