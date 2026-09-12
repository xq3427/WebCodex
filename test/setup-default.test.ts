import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupConfiguration } from '../src/setup.js';

test('setup without a workspace keeps its default outside the protected .webcodex directory', async () => {
  const temporaryRoot = await realpath(tmpdir());
  const base = await mkdtemp(path.join(temporaryRoot, 'webcodex-setup-default-'));
  try {
    const configPath = path.join(base, '.webcodex', 'config.toml');
    let installations = 0;
    const result = await setupConfiguration({ config: configPath }, { installTools: async options => {
      installations++;
      assert.equal(options.toolsDir, path.join(base, '.webcodex', 'tools'));
      return { nodePath: process.execPath, gitPath: process.execPath, rgPath: process.execPath, tunnelPath: process.execPath, installed: [] };
    } });
    assert.equal(installations, 1);
    assert.equal(result.report.created, true);
    assert.equal(result.config.workspaces[0].root, path.join(base, 'workspace'));
    assert.equal(result.config.execution.mode, 'disabled');
    assert.equal(result.config.codexSessions.enabled, false);
    await access(path.join(base, 'workspace'));
    await assert.rejects(access(path.join(base, '.webcodex', 'workspace')), { code: 'ENOENT' });
    const original = await readFile(configPath);
    const rerun = await setupConfiguration({ config: configPath }, { installTools: async () => { throw new Error('An existing configuration must be preserved.'); } });
    assert.equal(rerun.report.preserved, true);
    assert.deepEqual(await readFile(configPath), original);
  } finally {
    assert.equal(path.dirname(base), temporaryRoot);
    assert.ok(path.basename(base).startsWith('webcodex-setup-default-'));
    await rm(base, { recursive: true, force: true });
  }
});
