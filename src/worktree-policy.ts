import { createHash } from 'node:crypto';
import { lstatSync, openSync, closeSync, readSync, fstatSync, realpathSync, type Stats, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';
import { isProtectedName, within as inside } from './path-common.js';
import type { AppConfig, WorkspaceConfig } from './types.js';

export interface WorktreeAuthorization { gitDir: string; commonDir: string }
export interface VerifiedRepository extends WorktreeAuthorization { root: string; repositoryKind: 'normal' | 'linked-worktree'; fingerprint: string }
type AuthorizedWorkspace = WorkspaceConfig & { worktree?: WorktreeAuthorization };
const baselines = new WeakMap<AppConfig, Map<string, string>>();
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const equal = (left: string, right: string) => key(path.resolve(left)) === key(path.resolve(right));
const fail = () => new AppError('WORKTREE_INVALID', 'The linked worktree metadata is invalid, linked, or does not match its local authorization. Register the intended worktree again locally.');
// Windows lstat can report dev=0 while fstat reports the volume serial number.
// The canonical absolute path supplies the volume identity in that environment.
const signature = (info: BigIntStats) => [process.platform === 'win32' ? 'volume' : info.dev, info.ino, info.birthtimeNs].join(':');

/** Inspect every ancestor: a realpath containment check alone permits junction aliases. */
function directory(absolute: string): string {
  if (!path.isAbsolute(absolute) || /[\x00-\x1f\x7f]/.test(absolute)) throw fail();
  const resolved = path.resolve(absolute);
  let current = path.parse(resolved).root;
  for (const component of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw fail();
  }
  const real = realpathSync(resolved);
  if (!equal(real, resolved)) throw fail();
  return real;
}

function pointer(file: string): { text: string; fingerprint: string } {
  directory(path.dirname(file));
  const before = lstatSync(file,{bigint:true});
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 4096n) throw fail();
  const fd = openSync(file, 'r');
  try {
    const opened = fstatSync(fd,{bigint:true});
    if (signature(before) !== signature(opened) || before.size !== opened.size) throw fail();
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let count = 0;
    while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, count); if (!read) break; count += read; }
    const after = fstatSync(fd,{bigint:true}), current = lstatSync(file,{bigint:true});
    if (BigInt(count) !== opened.size || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || signature(current) !== signature(opened) || current.isSymbolicLink() || current.nlink !== 1n) throw fail();
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)); } catch { throw fail(); }
    if (/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/.test(text) || !/^[^\r\n]+(?:\r?\n)?$/.test(text)) throw fail();
    return { text: text.replace(/\r?\n$/, ''), fingerprint: [signature(opened), opened.size, opened.mtimeNs, opened.ctimeNs, createHash('sha256').update(bytes.subarray(0, count)).digest('hex')].join(':') };
  } finally { closeSync(fd); }
}

function resolvePointer(parent: string, text: string): string {
  if (!text || text !== text.trim() || /^[a-z]:[^\\/]/i.test(text) || /^\\\\[?.]\\/.test(text)) throw fail();
  return path.resolve(parent, text);
}

function inspectLinked(rootInput: string): VerifiedRepository {
  const root = directory(rootInput);
  const dotGit = pointer(path.join(root, '.git'));
  if (!dotGit.text.startsWith('gitdir: ')) throw fail();
  const gitDir = directory(resolvePointer(root, dotGit.text.slice(8)));
  const commonPointer = pointer(path.join(gitDir, 'commondir'));
  const commonDir = directory(resolvePointer(gitDir, commonPointer.text));
  // Support standard linked worktrees backed by a regular main checkout. Bare
  // repositories and submodule gitdirs need a separately reviewed policy.
  if (path.basename(commonDir).toLowerCase() !== '.git' || !equal(path.dirname(path.dirname(gitDir)), commonDir) || path.basename(path.dirname(gitDir)).toLowerCase() !== 'worktrees') throw fail();
  if (inside(commonDir, root) || inside(root, commonDir) || equal(path.dirname(commonDir), root)) throw fail();
  const reverse = pointer(path.join(gitDir, 'gitdir'));
  if (!equal(resolvePointer(gitDir, reverse.text), path.join(root, '.git'))) throw fail();
  directory(path.join(commonDir, 'objects'));
  directory(path.join(commonDir, 'refs'));
  if (pointer(path.join(root, '.git')).fingerprint !== dotGit.fingerprint || pointer(path.join(gitDir, 'commondir')).fingerprint !== commonPointer.fingerprint || pointer(path.join(gitDir, 'gitdir')).fingerprint !== reverse.fingerprint) throw fail();
  const fingerprint = createHash('sha256').update(JSON.stringify([key(root), key(gitDir), key(commonDir), signature(lstatSync(root,{bigint:true})), signature(lstatSync(gitDir,{bigint:true})), signature(lstatSync(commonDir,{bigint:true})), dotGit.fingerprint, commonPointer.fingerprint, reverse.fingerprint])).digest('hex');
  return { root, gitDir, commonDir, repositoryKind: 'linked-worktree', fingerprint };
}

/** Local registration only. It executes no Git command and reads no credentials. */
export function detectLinkedWorktree(root: string): WorktreeAuthorization {
  try { const { gitDir, commonDir } = inspectLinked(root); return { gitDir, commonDir }; } catch (error) { if (error instanceof AppError) throw error; throw fail(); }
}

/** Revalidate all three pointers. Callers must additionally apply workspace policy. */
export function validateLinkedWorktree(workspace: WorkspaceConfig): VerifiedRepository {
  try {
    const authorization = (workspace as AuthorizedWorkspace).worktree;
    if (!authorization) throw new AppError('WORKTREE_AUTHORIZATION_REQUIRED', 'Register this linked worktree locally with workspace add --worktree before accessing it.');
    const found = inspectLinked(workspace.root);
    if (!equal(found.gitDir, authorization.gitDir) || !equal(found.commonDir, authorization.commonDir)) throw fail();
    return found;
  } catch (error) { if (error instanceof AppError) throw error; throw fail(); }
}

/** Every configured metadata directory is private even through another workspace. */
export function protectedRepositoryPaths(config: AppConfig): string[] {
  return config.workspaces.flatMap(workspace => { const authorization = (workspace as AuthorizedWorkspace).worktree; return [path.join(workspace.root, '.git'), ...(authorization ? [authorization.gitDir, authorization.commonDir] : [])]; });
}

function serviceProtectedPaths(config: AppConfig): string[] {
  return [config.stateDir, config.configPath, config.configPath + '.lock', ...(config.toolsDir ? [config.toolsDir] : []), ...(config.nativeAttachment ? [config.nativeAttachment.runtimeDir, config.nativeAttachment.browser.userDataDir] : []), ...protectedRepositoryPaths(config)];
}

/** Only the precise authorized checkout beneath home/worktrees is exempted. */
function codexException(config: AppConfig, workspace: WorkspaceConfig, target: string): boolean {
  const home = config.codexSessions.home;
  if (!home || !inside(home, target)) return true;
  const worktrees = path.join(home, 'worktrees');
  return Boolean((workspace as AuthorizedWorkspace).worktree) && inside(worktrees, workspace.root) && !equal(worktrees, workspace.root) && inside(workspace.root, target);
}

function verifyRegisteredWorktree(config: AppConfig, workspace: WorkspaceConfig): void {
  const cache = baselines.get(config) ?? new Map<string, string>();
  baselines.set(config, cache);
  const cacheKey = workspace.id;
  const previous = cache.get(cacheKey);
  let found: VerifiedRepository;
  try { found = validateLinkedWorktree(workspace); }
  catch (error) { if (previous) throw new AppError('WORKTREE_METADATA_CHANGED', 'Worktree metadata changed while the service was running. Restore it or register and restart the intended worktree locally.'); throw error; }
  if (previous && previous !== found.fingerprint) throw new AppError('WORKTREE_METADATA_CHANGED', 'Worktree metadata changed while the service was running. Restore it or register and restart the intended worktree locally.');
  if (!previous) cache.set(cacheKey, found.fingerprint);
}

/** Static authorization also applies to disabled or temporarily unavailable roots. No filesystem IO. */
export function assertWorkspaceRootBoundary(config: AppConfig, workspace: WorkspaceConfig): void {
  if (serviceProtectedPaths(config).some(target => inside(target, workspace.root)) || !codexException(config, workspace, workspace.root)) throw new AppError('PATH_DENIED', 'Service configuration, state, repository metadata and Codex home are protected.');
  const home = config.codexSessions.home;
  let ancestor = path.parse(workspace.root).root;
  for (const component of workspace.root.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, component);
    const permittedCodexAncestor = component.toLowerCase() === '.codex' && home && inside(ancestor, home) && inside(home, workspace.root) && codexException(config, workspace, workspace.root);
    if (isProtectedName(component) && !permittedCodexAncestor) throw new AppError('PATH_DENIED', 'Workspace roots cannot be inside credential, service or repository metadata directories.');
  }
}

export function assertWorkspaceRoot(config: AppConfig, workspace: WorkspaceConfig): string {
  if (workspace.enabled === false) throw new AppError('WORKSPACE_DISABLED', 'This workspace is disabled in the local configuration.');
  assertWorkspaceRootBoundary(config, workspace);
  let root: string;
  try { root = directory(workspace.root); } catch { throw new AppError('PATH_DENIED', 'Workspace root changed or is a link.'); }
  if ((workspace as AuthorizedWorkspace).worktree) verifyRegisteredWorktree(config, workspace);
  else {
    let metadata: Stats | undefined;
    try { metadata = lstatSync(path.join(root, '.git')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (metadata?.isFile()) throw new AppError('WORKTREE_AUTHORIZATION_REQUIRED', 'Register this linked worktree locally with workspace add --worktree before accessing it.');
  }
  return root;
}

/** Pure boundary check for fs.resolve after it has already validated the root. */
export function isWorkspaceTargetAllowed(config: AppConfig, workspace: WorkspaceConfig, target: string): boolean {
  return path.isAbsolute(target) && inside(workspace.root, target) && !serviceProtectedPaths(config).some(protectedPath => inside(protectedPath, target)) && codexException(config, workspace, target);
}

/** This is an authorization check, not a substitute for per-component fs.resolve. */
export function workspaceAllowsPath(config: AppConfig, workspace: WorkspaceConfig, target: string): boolean {
  if (!isWorkspaceTargetAllowed(config, workspace, target)) return false;
  try { assertWorkspaceRoot(config, workspace); return true; } catch { return false; }
}

export function repositoryForWorkspace(config: AppConfig, workspace: WorkspaceConfig): VerifiedRepository {
  const root = assertWorkspaceRoot(config, workspace);
  if ((workspace as AuthorizedWorkspace).worktree) return validateLinkedWorktree(workspace);
  try { const gitDir = directory(path.join(root, '.git')); return { root, gitDir, commonDir: gitDir, repositoryKind: 'normal', fingerprint: '' }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('NOT_A_REPOSITORY', 'This workspace is not a Git repository.'); throw new AppError('UNSUPPORTED_REPOSITORY', 'Git metadata must be a normal directory without links or an explicitly authorized linked worktree.'); }
}
