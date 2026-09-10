import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, rename, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { App } from '../src/app.js';
import { defaultConfig, loadConfig } from '../src/config.js';
import { WorkspacePaths } from '../src/paths.js';
import { assertWorkspaceRoot, detectLinkedWorktree, validateLinkedWorktree, workspaceAllowsPath } from '../src/worktree-policy.js';
import type { WorkspaceConfig } from '../src/types.js';

async function fixture(t: TestContext, options: { noCommit?: boolean; external?: boolean; codexName?: boolean } = {}) {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-worktree-'));
  const main = path.join(base, 'main');
  const home = path.join(base, options.codexName ? '.codex' : 'codex-home');
  const root = options.external ? path.join(base, 'external-checkout') : path.join(home, 'worktrees', 'task', 'project');
  await mkdir(main);
  await mkdir(home);
  const apps: App[] = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-worktree-'));
    // Allow a bounded release interval for Windows Git worktree handles after
    // all fixture calls and Apps have finished. Persistent locks still fail.
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString('utf8').trim();
  git(main, 'init', '--quiet');
  git(main, 'config', 'user.name', 'WebCodex fixture');
  git(main, 'config', 'user.email', 'fixture@example.invalid');
  git(main, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(main, 'source.txt'), 'original\n');
  if (!options.noCommit) {
    git(main, 'add', 'source.txt');
    git(main, 'commit', '--quiet', '-m', 'fixture');
    git(main, 'worktree', 'add', '--quiet', '--detach', root);
  }
  const configPath = path.join(base, 'config.json');
  await writeFile(configPath, JSON.stringify(defaultConfig(main, configPath)));
  const config = await loadConfig(configPath);
  config.codexSessions.home = home;
  const worktree: WorkspaceConfig = { id: 'task', name: 'Task checkout', root, readOnly: false, ...(!options.noCommit ? { worktree: detectLinkedWorktree(root) } : {}) };
  const app = () => { const created = new App(config); apps.push(created); return created; };
  return { base, main, home, root, config, worktree, git, app };
}

test('authorized Codex linked worktree supports isolated file editing and Git status/diff', async t => {
  const f = await fixture(t);
  f.config.workspaces.push(f.worktree);
  const app = f.app();
  const original = await app.files.read({ workspace_id: 'task', path: 'source.txt' });
  await app.files.write({ workspace_id: 'task', path: 'source.txt', content: 'changed only in task\n', expected_sha256: original.sha256, idempotency_key: 'worktree-edit' });
  const status = await app.git.status({ workspace_id: 'task' });
  assert.equal(status.repository_kind, 'linked-worktree');
  assert.equal(status.root, f.root);
  assert.equal(status.branch, null);
  assert.equal(status.head, f.git(f.main, 'rev-parse', 'HEAD'));
  assert.ok(status.entries.some(entry => entry.path === 'source.txt' && entry.status === ' M'));
  assert.match((await app.git.diff({ workspace_id: 'task' })).output, /\+changed only in task/);
  assert.equal(await readFile(path.join(f.main, 'source.txt'), 'utf8'), 'original\n');
  assert.equal(f.git(f.main, 'status', '--porcelain'), '');
  assert.equal(workspaceAllowsPath(f.config, f.worktree, path.join(f.root, 'src')), true);
});

test('normal repositories report branch and null HEAD before their first commit', async t => {
  const f = await fixture(t, { noCommit: true });
  const status = await f.app().git.status({ workspace_id: 'default' });
  assert.equal(status.repository_kind, 'normal');
  assert.equal(status.head, null);
  assert.equal(status.branch, f.git(f.main, 'symbolic-ref', '--short', 'HEAD'));
});

test('linked worktrees outside Codex home also require explicit local authorization', async t => {
  const f = await fixture(t, { external: true });
  const unregistered = { ...f.worktree, worktree: undefined };
  f.config.workspaces.push(unregistered);
  assert.throws(() => assertWorkspaceRoot(f.config, unregistered), { code: 'WORKTREE_AUTHORIZATION_REQUIRED' });
  f.config.workspaces[1] = f.worktree;
  assert.equal((await new WorkspacePaths(f.config).resolve('task', 'source.txt')), path.join(f.root, 'source.txt'));
});

test('Codex home exception remains exact across parent aliases, searches and Git diffs', async t => {
  const f = await fixture(t);
  const metadata = detectLinkedWorktree(f.root);
  await mkdir(path.join(f.home, 'sessions'));
  await writeFile(path.join(f.home, 'auth.json'), 'SYNTHETIC_PRIVATE_NEEDLE');
  await writeFile(path.join(f.home, 'sessions', 'log.jsonl'), 'SYNTHETIC_PRIVATE_NEEDLE');
  await writeFile(path.join(metadata.gitDir, 'private-data'), 'SYNTHETIC_PRIVATE_NEEDLE');
  f.config.workspaces.push(f.worktree, { id: 'parent', name: 'Parent', root: f.base, readOnly: false });
  const app = f.app();
  for (const relative of ['codex-home/auth.json', 'codex-home/sessions/log.jsonl', 'codex-home/worktrees/task/project/source.txt', 'main/.git/config', 'state/state.sqlite', 'config.json']) {
    await assert.rejects(app.files.read({ workspace_id: 'parent', path: relative }), { code: 'PATH_DENIED' });
  }
  await assert.rejects(app.files.read({ workspace_id: 'task', path: '.git' }), { code: 'PATH_DENIED' });
  assert.equal((await app.files.search({ workspace_id: 'parent', query: 'SYNTHETIC_PRIVATE_NEEDLE' })).matches.length, 0);
  await writeFile(path.join(f.root, '.env'), 'SYNTHETIC_PRIVATE_NEEDLE\n');
  f.git(f.root, 'add', '--force', '.env');
  const diff = await app.git.diff({ workspace_id: 'task', staged: true });
  assert.equal(diff.hidden_files, 1);
  assert.equal(diff.output, '');
  for (const root of [f.home, path.join(f.home, 'sessions'), path.join(f.home, 'worktrees'), metadata.gitDir, metadata.commonDir]) {
    assert.throws(() => assertWorkspaceRoot(f.config, { ...f.worktree, root }), { code: 'PATH_DENIED' });
  }
});

test('wrong configured common directory and broken reverse pointers are rejected', async t => {
  const f = await fixture(t);
  const authorization = detectLinkedWorktree(f.root);
  assert.throws(() => validateLinkedWorktree({ ...f.worktree, worktree: { ...authorization, commonDir: f.base } }), { code: 'WORKTREE_INVALID' });
  await writeFile(path.join(authorization.gitDir, 'gitdir'), path.join(f.main, '.git') + '\n');
  assert.throws(() => detectLinkedWorktree(f.root), { code: 'WORKTREE_INVALID' });
});

test('metadata changes invalidate file mutations before an idempotent result can be reused', async t => {
  const f = await fixture(t);
  f.config.workspaces.push(f.worktree);
  const app = f.app();
  const input = { workspace_id: 'task', path: 'source.txt', content: 'authorized edit\n', expected_sha256: createHash('sha256').update('original\n').digest('hex'), idempotency_key: 'before-metadata-change' };
  await app.files.write(input);
  const file = path.join(f.root, '.git');
  const saved = await readFile(file);
  await rename(file, path.join(f.root, 'saved-pointer'));
  await writeFile(file, saved);
  await assert.rejects(app.files.write(input), { code: 'WORKTREE_METADATA_CHANGED' });
  await assert.rejects(app.git.status({ workspace_id: 'task' }), { code: 'WORKTREE_METADATA_CHANGED' });
  assert.equal(await readFile(path.join(f.root, 'source.txt'), 'utf8'), 'authorized edit\n');
});

test('worktree registration rejects junction ancestors and hard-linked pointer files', async t => {
  const f = await fixture(t);
  const alias = path.join(f.base, 'checkout-alias');
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => detectLinkedWorktree(alias), { code: 'WORKTREE_INVALID' });
  await link(path.join(f.root, '.git'), path.join(f.base, 'pointer-hardlink'));
  assert.throws(() => detectLinkedWorktree(f.root), { code: 'WORKTREE_INVALID' });
});

test('oversized pointer files and non-worktree Codex directories cannot be authorized', async t => {
  const f = await fixture(t);
  const copied = path.join(f.home, 'sessions');
  await mkdir(copied);
  await writeFile(path.join(copied, '.git'), await readFile(path.join(f.root, '.git')));
  assert.throws(() => detectLinkedWorktree(copied), { code: 'WORKTREE_INVALID' });
  // Git marks .git hidden on Windows; replacement avoids Node's hidden-file w mode.
  await rename(path.join(f.root, '.git'), path.join(f.root, 'original-pointer'));
  await writeFile(path.join(f.root, '.git'), 'gitdir: ' + 'a'.repeat(5000));
  assert.throws(() => detectLinkedWorktree(f.root), { code: 'WORKTREE_INVALID' });
});

test('linked worktree Git retains clean/process filter command protection', async t => {
  const f = await fixture(t);
  f.config.workspaces.push(f.worktree);
  const marker = path.join(f.base, 'filter-executed');
  f.git(f.main, 'config', 'filter.probe.clean', 'echo executed > ' + marker.replace(/\\/g, '/'));
  await writeFile(path.join(f.root, '.gitattributes'), '*.txt filter=probe\n');
  const app = f.app();
  await assert.rejects(app.git.status({ workspace_id: 'task' }), { code: 'GIT_FILTERS_UNSUPPORTED' });
  await assert.rejects(app.git.diff({ workspace_id: 'task' }), { code: 'GIT_FILTERS_UNSUPPORTED' });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('only configured .codex ancestor is exempt from protected workspace root names', async t => {
  const f = await fixture(t, { codexName: true });
  f.config.workspaces.push(f.worktree);
  assert.equal(assertWorkspaceRoot(f.config, f.worktree), f.root);
  assert.equal(await new WorkspacePaths(f.config).resolve('task', 'source.txt'), path.join(f.root, 'source.txt'));
  for (const protectedName of ['.ssh', '.webcodex', '.git']) {
    const checkout = path.join(f.base, protectedName, 'checkout');
    f.git(f.main, 'worktree', 'add', '--quiet', '--detach', checkout);
    const workspace: WorkspaceConfig = { id: 'private', name: 'Private', root: checkout, readOnly: false, worktree: detectLinkedWorktree(checkout) };
    assert.throws(() => assertWorkspaceRoot(f.config, workspace), { code: 'PATH_DENIED' });
  }
  const missingHome = { ...f.config, codexSessions: { ...f.config.codexSessions, home: null } };
  assert.throws(() => assertWorkspaceRoot(missingHome, f.worktree), { code: 'PATH_DENIED' });
});
