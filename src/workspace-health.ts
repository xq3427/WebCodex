import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';
import { assertWorkspaceRoot, assertWorkspaceRootBoundary } from './worktree-policy.js';
import type { AppConfig, WorkspaceConfig } from './types.js';

export type WorkspaceHealthStatus = 'available' | 'disabled' | 'missing' | 'inaccessible' | 'blocked' | 'identity_mismatch' | 'restart_required';
export interface WorkspaceHealth { status: WorkspaceHealthStatus; available: boolean; error_code: string | null; restart_required: boolean }
export const unavailableHealth = (status: Exclude<WorkspaceHealthStatus, 'available'>, code: string): WorkspaceHealth => ({ status, available: false, error_code: code, restart_required: status === 'restart_required' });
const normalizeRoot = (root: string) => process.platform === 'win32' ? root.toLowerCase() : root;
const runtimeRoots = new WeakMap<AppConfig, Map<string, string | null>>();
export function bindWorkspaceRuntime(config: AppConfig, roots: Map<string, string | null>): void { runtimeRoots.set(config, new Map(roots)); }

export function workspaceHealth(config: AppConfig, workspace: WorkspaceConfig): WorkspaceHealth {
  const inspected = inspectWorkspace(config, workspace);
  if (!inspected.health.available) return inspected.health;
  const bindings = runtimeRoots.get(config);
  if (bindings?.has(workspace.id)) {
    const expected = bindings.get(workspace.id);
    if (expected === null) return unavailableHealth('restart_required', 'WORKSPACE_RESTART_REQUIRED');
    if (expected !== inspected.fingerprint) return unavailableHealth('identity_mismatch', 'WORKSPACE_IDENTITY_MISMATCH');
  }
  return inspected.health;
}

export function assertWorkspaceAvailable(config: AppConfig, workspace: WorkspaceConfig): void {
  const health = workspaceHealth(config, workspace);
  if (!health.available) throw new AppError(health.error_code!, health.status === 'restart_required'
    ? 'This workspace was unavailable at startup. Restart the service after checking the local directory.'
    : 'This workspace is disabled, unavailable, or its directory identity changed. Check workspace_health before continuing.');
}

/** Metadata only. A pathname returning does not prove that the original project directory returned. */
export function inspectWorkspace(config: AppConfig, workspace: WorkspaceConfig): { health: WorkspaceHealth; root?: string; fingerprint?: string } {
  if (workspace.enabled === false) return { health: unavailableHealth('disabled', 'WORKSPACE_DISABLED') };
  try {
    assertWorkspaceRootBoundary(config, workspace);
    let ancestor = path.parse(workspace.root).root;
    for (const component of workspace.root.slice(ancestor.length).split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, component);
      const info = lstatSync(ancestor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new AppError('PATH_DENIED', 'The workspace directory is blocked.');
    }
    const before = lstatSync(workspace.root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new AppError('PATH_DENIED', 'The workspace directory is blocked.');
    const root = assertWorkspaceRoot(config, workspace);
    const after = lstatSync(workspace.root, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs || normalizeRoot(realpathSync(workspace.root)) !== normalizeRoot(root)) {
      throw new AppError('WORKSPACE_IDENTITY_MISMATCH', 'Workspace directory changed during inspection.');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([normalizeRoot(root), String(after.dev), String(after.ino), String(after.birthtimeNs)])).digest('hex');
    return { health: { status: 'available', available: true, error_code: null, restart_required: false }, root, fingerprint };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENODEV') return { health: unavailableHealth('missing', 'WORKSPACE_UNAVAILABLE') };
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return { health: unavailableHealth('inaccessible', 'WORKSPACE_UNAVAILABLE') };
    if (error instanceof AppError) return { health: unavailableHealth(code === 'WORKSPACE_IDENTITY_MISMATCH' ? 'identity_mismatch' : 'blocked', error.code) };
    return { health: unavailableHealth('blocked', 'PATH_DENIED') };
  }
}
