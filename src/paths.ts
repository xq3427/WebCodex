import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { AppError, markMissingWorkspacePath } from './errors.js';
import type { AppConfig, PathPolicy, ResolveOptions, WorkspaceConfig } from './types.js';
import { isWorkspaceTargetAllowed } from './worktree-policy.js';
import { isProtectedName, within } from './path-common.js';
import { assertWorkspaceAvailable } from './workspace-health.js';
export { isProtectedName, within } from './path-common.js';

const reserved = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
export class WorkspacePaths implements PathPolicy {
  constructor(private config: AppConfig) {}
  list(): WorkspaceConfig[] { return this.config.workspaces.map(w => ({...w})); }
  get(id: string) { const w = this.config.workspaces.find(x => x.id === id); if (!w) throw new AppError('WORKSPACE_NOT_FOUND','Unknown or unauthorized workspace.'); if (w.enabled === false) throw new AppError('WORKSPACE_DISABLED','This workspace is disabled in the local configuration.'); return {...w}; }
  async resolve(id: string, relative: string, options: ResolveOptions = {}): Promise<string> {
    const workspace = this.get(id);
    if (options.write && workspace.readOnly) throw new AppError('READ_ONLY','This workspace is read-only.');
    if (typeof relative !== 'string' || relative.length > 2048 || /^[\\/]/.test(relative) || /[:\x00-\x1f\x7f]/.test(relative) || path.isAbsolute(relative)) throw new AppError('PATH_DENIED','Only workspace-relative file paths are accepted.');
    const components = relative.replace(/\\/g,'/').split('/').filter(x => x !== '' && x !== '.');
    for (const part of components) {
      if (part === '..' || /[. ]$/.test(part) || /[<>"|?*]/.test(part) || reserved.test(part) || isProtectedName(part)) throw new AppError('PATH_DENIED','This path contains a protected or unsupported component.');
    }
    const target = path.resolve(workspace.root,...components);
    if (!within(workspace.root,target)) throw new AppError('PATH_DENIED','Path escapes workspace.');
    assertWorkspaceAvailable(this.config, workspace);
    if (!isWorkspaceTargetAllowed(this.config, workspace, target)) throw new AppError('PATH_DENIED','Service configuration, state and repository metadata are protected.');
    const rootInfo = await lstat(workspace.root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || path.relative(workspace.root,await realpath(workspace.root)) !== '') throw new AppError('PATH_DENIED','Workspace root changed or is a link.');
    let current = workspace.root;
    let last = rootInfo;
    for (let i = 0; i < components.length; i++) {
      current = path.join(current,components[i]);
      try { last = await lstat(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // A disappearing workspace root is not a missing project subdirectory.
          assertWorkspaceAvailable(this.config, workspace);
          if (options.allowMissing && i === components.length - 1) return target;
          throw markMissingWorkspacePath(error, i < components.length - 1 ? 'parent_not_found' : 'target_not_found', options.write === true);
        }
        throw error;
      }
      if (last.isSymbolicLink() || (!last.isDirectory() && !last.isFile())) throw new AppError('PATH_DENIED','Links and special filesystem objects are not supported.');
      if (last.isFile() && last.nlink > 1) throw new AppError('PATH_DENIED','Hard-linked files are not supported.');
      const finalPath = await realpath(current);
      if (!within(workspace.root,finalPath)) throw new AppError('PATH_DENIED','Resolved path escapes workspace.');
      if (!isWorkspaceTargetAllowed(this.config, workspace, finalPath)) throw new AppError('PATH_DENIED','Resolved service configuration, state and repository metadata are protected.');
      if (i < components.length - 1 && !last.isDirectory()) throw new AppError('NOT_DIRECTORY','A parent component is not a directory.');
    }
    if (options.directory && !last.isDirectory()) throw new AppError('NOT_DIRECTORY','Expected a directory.');
    return target;
  }
}
