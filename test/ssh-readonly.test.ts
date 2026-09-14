import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readonlySshCommand } from '../src/ssh-readonly.js';

test('fixed SSH probes do not accept caller supplied shell syntax', () => {
  assert.equal(readonlySshCommand('identity'), 'whoami');
  assert.match(readonlySshCommand('project_candidates'), /^find \/workspace/);
  assert.equal(readonlySshCommand('git_status', '/workspace/Source Detection'), "git -C '/workspace/Source Detection' status --short --branch");
  assert.throws(() => readonlySshCommand('git_status'), { code: 'SSH_PROJECT_ROOT_REQUIRED' });
  for (const kind of ['identity', 'roots', 'project_candidates', 'git_status', 'processes', 'gpu', 'directory_listing'] as const) {
    const command = readonlySshCommand(kind, '/tmp/project');
    assert.doesNotMatch(command, /rm\s|touch\s|>\s|>>|mkdir\s|nohup\s|curl\s|wget\s/);
  }
});
