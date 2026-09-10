import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultUnifiedConfig } from '../src/config.js';
import { serializeConfig } from '../src/config-format.js';
import { detectLinkedWorktree } from '../src/worktree-policy.js';

const ID = '11111111-1111-4111-8111-111111111111';
const runFile = promisify(execFile);
const row = (ordinal: number, type: string, payload: unknown) => ({ ordinal, timestamp: '2026-09-08T00:00:00Z', type, payload });
const jsonl = (...rows: unknown[]) => rows.map(value => JSON.stringify(value) + '\n').join('');

test('isolated stdio emergency loop resumes a real linked worktree from long Codex history, proves failing/passing tests and saves a checkpoint', async () => {
  const parent = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(parent, 'webcodex-emergency-integration-'));
  const main = path.join(base, 'main');
  const home = path.join(base, 'synthetic-codex-home');
  const checkout = path.join(home, 'worktrees', 'fixture-task', 'project');
  const configPath = path.join(base, 'config.toml');
  const historyFile = path.join(home, 'sessions', `rollout-${ID}.jsonl`);
  const gitEnvironment: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) gitEnvironment[key] = process.env[key];
  const git = (args: string[]) => runFile('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], { cwd: main, env: gitEnvironment, windowsHide: true });
  const client = new Client({ name: 'synthetic-codex-emergency-test', version: '1.0' });
  try {
    await fs.mkdir(main);
    await fs.mkdir(path.dirname(checkout), { recursive: true });
    await fs.mkdir(path.dirname(historyFile), { recursive: true });
    await fs.writeFile(path.join(main, 'calc.mjs'), 'export const add = (a, b) => a - b;\n');
    await fs.writeFile(path.join(main, 'calc.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\ntest('addition preserves both operands', () => { assert.equal(add(2, 3), 5); });\n");
    await fs.writeFile(path.join(main, 'AGENTS.md'), 'Run node --test calc.test.mjs after changing calc.mjs.\n');
    await git(['init']);
    await git(['add', 'calc.mjs', 'calc.test.mjs', 'AGENTS.md']);
    await git(['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic failing test fixture']);
    await git(['worktree', 'add', '-b', 'emergency-fixture', checkout]);
    const instruction = '上下文🙂'.repeat(24_000) + '\nIMPORTANT-FINAL-REQUIREMENT: Fix add to return the sum; run the actual regression test and save a checkpoint.';
    const historyBytes = Buffer.from(jsonl(
      row(0, 'session_meta', { id: ID, cwd: checkout }),
      row(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: instruction }] }),
      row(2, 'response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Quota ended before the implementation. No tests have passed yet.' }] }),
    ));
    await fs.writeFile(historyFile, historyBytes);
    await fs.writeFile(path.join(home, 'auth.json'), '{"api_key":"SYNTHETIC-PRIVATE-AUTH"}');
    const raw = defaultUnifiedConfig(checkout, configPath, { deviceName: 'Synthetic emergency workstation' });
    const configured = {
      ...raw,
      workspaces: [{ ...raw.workspaces[0], worktree: detectLinkedWorktree(checkout) }],
      execution: { ...raw.execution, mode: 'trusted-host' },
      codexSessions: { ...raw.codexSessions, enabled: true, home },
    };
    await fs.writeFile(configPath, serializeConfig(configured, 'toml'));
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'serve', '--config', configPath], stderr: 'pipe' });
    await client.connect(transport);
    const call = async (name: string, input: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: input });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.equal((result.structuredContent as any).ok, true);
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-PRIVATE-AUTH/);
      return (result.structuredContent as any).data;
    };
    const status = await call('system_status');
    const device = status.device_id;
    const sessions = await call('codex_session_list');
    assert.equal(sessions.sessions[0].workspace_id, 'default');
    const handoff = await call('codex_session_handoff', { session_id: ID, max_bytes: 8192 });
    assert.equal(handoff.workspace_authorized, true);
    assert.equal(handoff.workspace.git.repository_kind, 'linked-worktree');
    assert.equal(handoff.workspace.git.branch, 'emergency-fixture');
    assert.equal(path.resolve(handoff.workspace.git.root), checkout);
    const chunks = new Map<string, { bytes: number; text: string }>();
    let transcript = handoff.transcript;
    for (let pages = 0; pages < 100; pages++) {
      for (const entry of transcript.entries) {
        const part = chunks.get(entry.entry_id) ?? { bytes: 0, text: '' };
        assert.equal(part.bytes, entry.chunk.offset_bytes);
        part.text += entry.text;
        part.bytes = entry.chunk.end_bytes;
        chunks.set(entry.entry_id, part);
      }
      if (!transcript.next_cursor) break;
      transcript = await call('codex_session_read', { session_id: ID, cursor: transcript.next_cursor, max_bytes: 8192 });
    }
    assert.equal(transcript.next_cursor, null);
    assert.equal(transcript.scan_complete, true);
    assert.ok([...chunks.values()].some(part => part.text === instruction));
    const old = await call('fs_read', { workspace_id: 'default', path: 'calc.mjs' });
    const wrongDevice = await client.callTool({ name: 'fs_write', arguments: { workspace_id: 'default', path: 'calc.mjs', content: 'bad', expected_sha256: old.sha256, expected_device_id: '33333333-3333-4333-8333-333333333333', idempotency_key: 'wrong-device' } });
    assert.equal((wrongDevice.structuredContent as any).error.code, 'DEVICE_MISMATCH');
    const runTest = async (key: string) => {
      const started = await call('exec_start', { workspace_id: 'default', expected_device_id: device, executable: 'node', args: ['--test', 'calc.test.mjs'], idempotency_key: key });
      let cursor = 0, output = '', completed: any;
      for (let polls = 0; polls < 200; polls++) {
        const result = await call('exec_poll', { workspace_id: 'default', job_id: started.job_id, cursor });
        cursor = result.next_cursor;
        output += result.output.map((chunk: any) => chunk.text).join('');
        if (!['queued', 'running'].includes(result.status)) { completed = result; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(completed, 'real node test must reach a terminal state');
      return { ...completed, job_id: started.job_id, output };
    };
    const failing = await runTest('baseline-test');
    assert.equal(failing.status, 'failed');
    assert.notEqual(failing.exit_code, 0);
    assert.match(failing.output, /addition preserves both operands/);
    await call('fs_write', { workspace_id: 'default', expected_device_id: device, path: 'calc.mjs', content: 'export const add = (a, b) => a + b;\n', expected_sha256: old.sha256, idempotency_key: 'fix-addition' });
    const passing = await runTest('fixed-test');
    assert.equal(passing.status, 'succeeded');
    assert.equal(passing.exit_code, 0);
    assert.match(passing.output, /addition preserves both operands/);
    assert.match(passing.output, /# pass 1/);
    const diff = await call('git_diff', { workspace_id: 'default' });
    assert.match(diff.output, /a \+ b/);
    assert.equal((await call('checkpoint_read', { workspace_id: 'default' })).exists, false);
    await call('checkpoint_save', { workspace_id: 'default', expected_device_id: device, objective: 'Fix addition from Codex history.', progress: 'Read the complete final requirement and fixed calc.mjs.', next_steps: 'Resume Codex in this same worktree and review the diff.', verification_notes: 'Executed node --test calc.test.mjs before and after editing; baseline failed, the second run passed one assertion test.', session_id: ID, job_ids: [failing.job_id, passing.job_id], expected_sha256: null, idempotency_key: 'save-handoff' });
    const checkpoint = await call('checkpoint_read', { workspace_id: 'default' });
    assert.match(checkpoint.content, /"exit_code": 0/);
    assert.match(checkpoint.content, /"status": "failed"/);
    assert.match(checkpoint.content, /not independently verified/);
    assert.equal(await fs.readFile(path.join(main, 'calc.mjs'), 'utf8'), 'export const add = (a, b) => a - b;\n');
    assert.deepEqual(await fs.readFile(historyFile), historyBytes);
    assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), '{"api_key":"SYNTHETIC-PRIVATE-AUTH"}');
  } finally {
    await client.close();
    const actual = await fs.realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-emergency-integration-'));
    await fs.rm(actual, { recursive: true, force: true });
  }
});
