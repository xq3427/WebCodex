import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { App } from '../src/app.js';
import { defaultConfig } from '../src/config.js';
import { ProjectContextService } from '../src/project-context.js';
import { detectLinkedWorktree } from '../src/worktree-policy.js';
import type { WorkspaceConfig } from '../src/types.js';

async function fixture(t: TestContext, prepare?: (base: string, root: string) => Promise<void>) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-context-'));
  const root = path.join(base, 'project'); await mkdir(root);
  const apps: App[] = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    const absolute = await realpath(base);
    assert.equal(path.dirname(absolute), parent); assert.ok(path.basename(absolute).startsWith('webcodex-context-'));
    await rm(absolute, { recursive: true, force: true });
  });
  if (prepare) await prepare(base, root);
  const configPath = path.join(base, 'config.json');
  const initial = defaultConfig(root, configPath);
  const config = { ...initial, workspaces: initial.workspaces as WorkspaceConfig[], configPath, projectContext: { maxDepth: 32, maxFileBytes: 65536, maxTotalBytes: 262144 } };
  const app = new App(config); apps.push(app);
  const service = new ProjectContextService(app.ctx);
  return { parent, base, root, config, app, service, apps };
}

test('context follows root-to-target precedence, chooses one override at each level, and ignores external guidance', async t => {
  const f = await fixture(t); await mkdir(path.join(f.root, 'src', 'feature'), { recursive: true });
  await writeFile(path.join(f.base, 'AGENTS.md'), 'OUTSIDE_WORKSPACE');
  for (const [file, content] of [['AGENTS.md', 'root guidance'], ['src/AGENTS.md', 'ignored normal'], ['src/AGENTS.override.md', 'source override'], ['src/feature/AGENTS.md', 'feature guidance']]) await writeFile(path.join(f.root, file), content);
  const result = await f.service.read({ workspace_id: 'default', path: 'src/feature/new.ts' });
  assert.equal(result.target_kind, 'missing_file'); assert.equal(result.target, 'src/feature/new.ts');
  assert.deepEqual(result.guidance.map(row => [row.source, row.applies_to, row.precedence, row.content]), [
    ['AGENTS.md', '.', 0, 'root guidance'], ['src/AGENTS.override.md', 'src', 1, 'source override'], ['src/feature/AGENTS.md', 'src/feature', 2, 'feature guidance'],
  ]);
  assert.equal(result.complete, true); assert.equal(result.scan_complete, true); assert.equal(result.next_cursor, null);
  const directory = await f.service.read({ workspace_id: 'default', path: 'src/feature' });
  assert.equal(directory.target_kind, 'directory'); assert.deepEqual(directory.guidance, result.guidance);
  const root = await f.service.read({ workspace_id: 'default' }); assert.deepEqual(root.guidance.map(row => row.content), ['root guidance']);
});

test('context redacts complete long credentials before chunking and reassembles Chinese without loss', async t => {
  const f = await fixture(t);
  const secret = 'TOKEN_FRAGMENT_SHOULD_NEVER_ESCAPE'.repeat(100);
  const raw = '指南中文😀'.repeat(600) + '\napi_key="' + secret + '"\n' + '结尾🙂'.repeat(300);
  const expected = raw.replace(secret, '[REDACTED]');
  await writeFile(path.join(f.root, 'AGENTS.md'), raw);
  let cursor: string | undefined, text = '', offset = 0, pages = 0;
  do {
    const result = await f.service.read({ workspace_id: 'default', cursor, max_bytes: 257 });
    assert.equal(result.guidance.length, 1); const row = result.guidance[0];
    assert.equal(row.chunk.offset_bytes, offset); assert.equal(row.sha256, createHash('sha256').update(raw).digest('hex'));
    assert.equal(row.redactions, 1); assert.ok(!JSON.stringify(result).includes('TOKEN_FRAGMENT'));
    assert.ok(!row.content.includes('\ufffd')); assert.ok(result.returned_bytes <= 257);
    text += row.content; offset = row.chunk.end_bytes; cursor = result.next_cursor ?? undefined;
    assert.equal(result.complete, cursor === undefined); assert.ok(++pages < 200);
  } while (cursor);
  assert.ok(pages > 30); assert.equal(text, expected); assert.equal(offset, Buffer.byteLength(expected));
});

test('context cursors retry stably and allow response-budget changes, but reject target/source/selection/limit changes', async t => {
  const f = await fixture(t); await mkdir(path.join(f.root, 'src'));
  const source = path.join(f.root, 'AGENTS.md'); await writeFile(source, '文😀'.repeat(500));
  const input = { workspace_id: 'default', path: 'src/new.ts', max_bytes: 256 };
  const first = await f.service.read(input); assert.ok(first.next_cursor);
  const continuation = { ...input, cursor: first.next_cursor! };
  const second = await f.service.read(continuation); assert.deepEqual(await f.service.read(continuation), second);
  assert.equal((await f.service.read({ ...continuation, max_bytes: 513 })).guidance[0].chunk.offset_bytes, first.guidance[0].chunk.end_bytes);
  await assert.rejects(f.service.read({ ...continuation, path: 'src/different.ts' }), { code: 'INVALID_CURSOR' });
  await assert.rejects(f.service.read({ ...continuation, cursor: first.next_cursor!.slice(0, -3) + 'abc' }), { code: 'INVALID_CURSOR' });
  await assert.rejects(new ProjectContextService(f.app.ctx).read(continuation), { code: 'INVALID_CURSOR' });
  f.config.projectContext.maxDepth = 4; await assert.rejects(f.service.read(continuation), { code: 'CONTEXT_CURSOR_STALE' }); f.config.projectContext.maxDepth = 32;
  await writeFile(path.join(f.root, 'src', 'AGENTS.override.md'), 'new scope');
  await assert.rejects(f.service.read(continuation), { code: 'CONTEXT_CURSOR_STALE' });
  const again = await f.service.read(input); await writeFile(source, 'different content'.repeat(100));
  await assert.rejects(f.service.read({ ...input, cursor: again.next_cursor! }), { code: 'CONTEXT_CURSOR_STALE' });
  const replacement = await f.service.read(input); await rename(source, source + '.old'); await writeFile(source, 'different content'.repeat(100));
  await assert.rejects(f.service.read({ ...input, cursor: replacement.next_cursor! }), { code: 'CONTEXT_CURSOR_STALE' });
  const missing = await f.service.read(input); await writeFile(path.join(f.root, 'src', 'new.ts'), 'created');
  await assert.rejects(f.service.read({ ...input, cursor: missing.next_cursor! }), { code: 'CONTEXT_CURSOR_STALE' });
});

test('context explicitly reports oversized, unreadable encoding and deep guidance without partial fallback', async t => {
  const f = await fixture(t); Object.assign(f.config.projectContext, { maxDepth: 1, maxFileBytes: 1024, maxTotalBytes: 2048 });
  await mkdir(path.join(f.root, 'src', 'deep'), { recursive: true });
  await writeFile(path.join(f.root, 'AGENTS.md'), 'must not fallback');
  await writeFile(path.join(f.root, 'AGENTS.override.md'), 'A'.repeat(1025));
  await writeFile(path.join(f.root, 'src', 'AGENTS.md'), Buffer.from([0xff, 1, 2]));
  await writeFile(path.join(f.root, 'src', 'deep', 'AGENTS.md'), 'too deep');
  const result = await f.service.read({ workspace_id: 'default', path: 'src/deep/new.ts' });
  assert.equal(result.complete, true); assert.equal(result.scan_complete, false); assert.deepEqual(result.guidance, []);
  assert.deepEqual(result.omissions.map(row => [row.source, row.reason]), [
    ['AGENTS.override.md', 'FILE_TOO_LARGE'], ['src/AGENTS.md', 'UNSUPPORTED_ENCODING'], ['src/deep', 'MAX_DEPTH_EXCEEDED'],
  ]);
  assert.equal(result.scanned_bytes, 3);
});

test('context bounds the entire chain and makes skipped child documents visible', async t => {
  const f = await fixture(t); Object.assign(f.config.projectContext, { maxFileBytes: 2048, maxTotalBytes: 2048 });
  await mkdir(path.join(f.root, 'src')); await writeFile(path.join(f.root, 'AGENTS.md'), 'r'.repeat(1500));
  await writeFile(path.join(f.root, 'src', 'AGENTS.md'), 's'.repeat(1500));
  const result = await f.service.read({ workspace_id: 'default', path: 'src' });
  assert.equal(result.scanned_bytes, 1500); assert.equal(result.guidance.length, 1);
  assert.equal(result.omissions[0].reason, 'TOTAL_BYTES_EXCEEDED'); assert.equal(result.scan_complete, false);
  assert.equal(result.complete, true);
});

test('context denies protected targets, missing ancestors and hardlinked sources; unsafe override never falls back', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'AGENTS.md'), 'must not fallback');
  await writeFile(path.join(f.base, 'outside.txt'), 'PRIVATE_OUTSIDE'); await link(path.join(f.base, 'outside.txt'), path.join(f.root, 'AGENTS.override.md'));
  const linked = await f.service.read({ workspace_id: 'default' });
  assert.deepEqual(linked.guidance, []); assert.equal(linked.omissions[0].reason, 'PATH_DENIED');
  for (const target of ['../outside.txt', '.env', '.codex/auth.json', '.git/config']) await assert.rejects(f.service.read({ workspace_id: 'default', path: target }), { code: 'PATH_DENIED' });
  await assert.rejects(f.service.read({ workspace_id: 'default', path: 'missing/child.ts' }), { code: 'ENOENT' });
});

test('context denies a file symlink guidance source without exposing outside content', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.base, 'outside.txt'), 'PRIVATE_OUTSIDE');
  await mkdir(path.join(f.root, 'src'));
  try { await symlink(path.join(f.base, 'outside.txt'), path.join(f.root, 'src', 'AGENTS.md'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      const message = 'File symlink coverage requires Windows Developer Mode or the symlink privilege. Re-run from an administrator PowerShell or a Windows environment with Developer Mode enabled; this test does not change system settings.';
      if (process.env.WEBCODEX_REQUIRE_FILE_SYMLINK_TESTS === '1') throw new Error(message, { cause: error });
      t.skip(message); return;
    }
    throw error;
  }
  const symbolic = await f.service.read({ workspace_id: 'default', path: 'src' });
  assert.ok(symbolic.omissions.some(row => row.source === 'src/AGENTS.md' && row.reason === 'PATH_DENIED'));
  assert.ok(!JSON.stringify(symbolic).includes('PRIVATE_OUTSIDE'));
});

test('context handles empty guidance and BOM UTF16 in both byte orders', async t => {
  const f = await fixture(t); await mkdir(path.join(f.root, 'src')); await writeFile(path.join(f.root, 'AGENTS.override.md'), '');
  await writeFile(path.join(f.root, 'AGENTS.md'), 'ignored even for empty override');
  for (const bigEndian of [false, true]) {
    const text = '完整中文😀\r\n'.repeat(40); let body = Buffer.from(text, 'utf16le'); if (bigEndian) body = body.swap16();
    await writeFile(path.join(f.root, 'src', 'AGENTS.md'), Buffer.concat([Buffer.from(bigEndian ? [254, 255] : [255, 254]), body]));
    const result = await f.service.read({ workspace_id: 'default', path: 'src' });
    assert.equal(result.guidance[0].content, ''); assert.equal(result.guidance[1].content, text); assert.equal(result.complete, true);
  }
  await assert.rejects(f.service.read({ workspace_id: 'default', max_bytes: 1 }), { code: 'INVALID_ARGUMENT' });
});

test('explicitly authorized Codex worktrees expose only their own guidance chain', async t => {
  const f = await fixture(t, async (_base, root) => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
    git('init', '--quiet'); git('config', 'user.name', 'WebCodex context fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(root, 'AGENTS.md'), 'main checkout'); git('add', 'AGENTS.md'); git('commit', '--quiet', '-m', 'fixture');
  });
  await f.app.close();
  const home = path.join(f.base, '.codex'), worktree = path.join(home, 'worktrees', 'task', 'project');
  execFileSync('git', ['worktree', 'add', '--quiet', '--detach', worktree], { cwd: f.root, windowsHide: true, stdio: 'pipe' });
  await writeFile(path.join(worktree, 'AGENTS.md'), 'task checkout'); await writeFile(path.join(home, 'AGENTS.md'), 'HOME_PRIVATE');
  f.config.codexSessions.home = home; f.config.workspaces.push({ id: 'task', name: 'task', root: worktree, readOnly: false, worktree: detectLinkedWorktree(worktree) });
  const app = new App(f.config); f.apps.push(app); const context = new ProjectContextService(app.ctx);
  const result = await context.read({ workspace_id: 'task' }); assert.deepEqual(result.guidance.map(row => row.content), ['task checkout']);
  await assert.rejects(context.read({ workspace_id: 'task', path: '../AGENTS.md' }), { code: 'PATH_DENIED' });
  const main = await context.read({ workspace_id: 'default' }); assert.deepEqual(main.guidance.map(row => row.content), ['main checkout']);
});
