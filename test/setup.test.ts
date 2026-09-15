import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupConfiguration } from '../src/setup.js';
import { AppError } from '../src/errors.js';
import type { SetupToolsOptions } from '../src/setup-tools.js';

async function fixture() {
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'webcodex-setup-'));
  return { base, config: path.join(base, '配置 空格', 'config.toml'), workspace: path.join(base, '论文 工作区'),
    clean: async () => { assert.ok(path.basename(base).startsWith('webcodex-setup-')); await rm(base, { recursive: true, force: true }); } };
}
const fakeTools = async (_options: SetupToolsOptions) => ({ nodePath: process.execPath, gitPath: process.execPath,
  rgPath: process.execPath, tunnelPath: process.execPath, installed: [] });

test('setup creates a private portable config with requested Codex-like local access after tools succeed', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const result = await setupConfiguration({ config: f.config, workspace: f.workspace, proxyUrl: 'http://127.0.0.1:8080' }, { installTools: async options => {
      calls++; assert.equal(options.toolsDir, path.join(path.dirname(f.config), 'tools'));
      assert.equal(options.proxyUrl, 'http://127.0.0.1:8080');
      await assert.rejects(access(f.config));
      return fakeTools(options);
    } });
    assert.equal(calls, 1);
    assert.equal(result.report.created, true);
    assert.equal(result.config.execution.mode, 'trusted-host');
    assert.equal(result.config.execution.commandPolicy, 'all');
    assert.equal(result.config.workspaces[0].readOnly, false);
    assert.equal(result.config.codexSessions?.enabled, false);
    assert.equal(result.config.tunnel?.enabled, false);
    assert.equal(result.config.tunnel?.proxyUrl, '');
    assert.ok(result.config.http.bearerToken!.length >= 32);
    const report = JSON.stringify(result.report);
    assert.ok(!report.includes(result.config.http.bearerToken!));
    assert.match(await readFile(f.config, 'utf8'), /\$\{configDir\}/);
  } finally { await f.clean(); }
});

test('setup rerun preserves exact configuration bytes, identity and token without changing workspace or installing tools', async () => {
  const f = await fixture();
  try {
    const first = await setupConfiguration({ config: f.config, workspace: f.workspace }, { installTools: fakeTools });
    const before = await readFile(f.config);
    const second = await setupConfiguration({ config: f.config, workspace: path.join(f.base, 'ignored') }, { installTools: async () => { throw new Error('must not install'); } });
    assert.equal(second.report.preserved, true);
    assert.equal(second.report.dependencies_checked, false);
    assert.deepEqual(await readFile(f.config), before);
    assert.equal(second.config.device?.id, first.config.device?.id);
    assert.equal(second.config.http.bearerToken, first.config.http.bearerToken);
    await assert.rejects(access(path.join(f.base, 'ignored')));
  } finally { await f.clean(); }
});

test('setup download failure leaves no successful configuration and can be retried', async () => {
  const f = await fixture();
  try {
    await assert.rejects(setupConfiguration({ config: f.config, workspace: f.workspace }, { installTools: async () => { throw new AppError('SETUP_DOWNLOAD_FAILED', 'Synthetic download failure'); } }), { code: 'SETUP_DOWNLOAD_FAILED' });
    await assert.rejects(access(f.config));
    const retry = await setupConfiguration({ config: f.config, workspace: f.workspace }, { installTools: fakeTools });
    assert.equal(retry.report.created, true);
  } finally { await f.clean(); }
});
