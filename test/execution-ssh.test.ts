import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../src/config.js';
import { App } from '../src/app.js';
import { executionEnvironment, normalizeExecutionEnvironment } from '../src/execution-env.js';

test('ProgramData is inherited only as a Windows host prerequisite, never as a configured override', () => {
  const name = Object.keys(process.env).find(key => key.toUpperCase() === 'PROGRAMDATA') ?? 'ProgramData';
  const prior = process.env[name];
  const sentinel = path.join(tmpdir(), 'synthetic-system-data');
  try {
    process.env[name] = sentinel;
    const env = executionEnvironment();
    assert.equal(env[name], process.platform === 'win32' ? sentinel : undefined);
    for (const spelling of ['ProgramData', 'PROGRAMDATA', 'programdata']) {
      assert.throws(() => normalizeExecutionEnvironment({ [spelling]: sentinel }), { code: 'INVALID_EXECUTION_ENV' });
    }
    delete process.env[name];
    assert.equal(Object.keys(executionEnvironment()).some(key => key.toUpperCase() === 'PROGRAMDATA'), false);
  } finally { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; }
});

async function nativeSsh(t: TestContext) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.ok(systemRoot && path.isAbsolute(systemRoot));
  const ssh = path.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe');
  try { await access(ssh); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || process.env.CI === 'true') throw error;
    t.skip('Windows OpenSSH client is not installed.'); return;
  }
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-ssh-test-'));
  const root = path.join(base, 'workspace'); await mkdir(root);
  const configPath = path.join(base, 'config.json'), config = defaultConfig(root, configPath);
  const app = new App({ ...config, configPath, execution: { ...config.execution, mode: 'trusted-host', commandPolicy: 'all' } });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(await realpath(base)), parent);
    assert.ok(path.basename(base).startsWith('webcodex-ssh-test-'));
    await rm(base, { recursive: true, force: true });
  });
  const run = async (args: string[], key: string) => {
    const job = await app.jobs.start({ workspace_id: 'default', executable: ssh, args, timeout_ms: 5000, idempotency_key: key });
    let cursor = 0;
    for (let attempts = 0; attempts < 40; attempts++) {
      const observed = await app.jobs.wait({ workspace_id: 'default', job_id: job.job_id, cursor, wait_ms: 250 });
      cursor = observed.next_cursor;
      if (observed.terminal) return app.jobs.poll({ workspace_id: 'default', job_id: job.job_id });
    }
    throw new Error('Local SSH probe did not reach a terminal state.');
  };
  return { app, run };
}

test('Windows OpenSSH starts and its real stderr survives job completion and polling', { skip: process.platform !== 'win32' }, async t => {
  const f = await nativeSsh(t); if (!f) return;
  // Version and invalid-option probes use no keys, user SSH configuration or network.
  const version = await f.run(['-V'], 'version');
  assert.equal(version.status, 'succeeded'); assert.equal(version.exit_code, 0);
  assert.match(version.output.filter(c => c.stream === 'stderr').map(c => c.text).join(''), /OpenSSH_for_Windows_/);
  const invalid = await f.run(['-o', 'WebCodexSyntheticInvalidOption=yes', '-V'], 'invalid-option');
  assert.equal(invalid.status, 'failed'); assert.equal(invalid.exit_code, 255);
  assert.equal(invalid.output_truncated, false);
  const tail = f.app.jobs.tail({ workspace_id: 'default', job_id: invalid.job_id, stream: 'stderr' });
  assert.match(tail.output.map(c => c.text).join(''), /Bad configuration option:/i);
  assert.equal(tail.output.map(c => c.text).join(''), invalid.output.filter(c => c.stream === 'stderr').map(c => c.text).join(''));
  assert.equal(invalid.failure_diagnostics, undefined);
});
