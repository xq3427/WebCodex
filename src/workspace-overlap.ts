import path from 'node:path';
import { AppError } from './errors.js';
import { within } from './path-common.js';
import type { WorkspaceConfig } from './types.js';

/** Validate canonical roots before service startup; a nested entry cannot narrow another entry's authorization. */
export function assertCompatibleWorkspaceRoots(workspaces: WorkspaceConfig[]): void {
  const roots = workspaces.map(workspace => {
    const absolute = path.resolve(workspace.root);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  });
  for (let left = 0; left < workspaces.length; left++) {
    for (let right = left + 1; right < workspaces.length; right++) {
      if (workspaces[left].enabled === false || workspaces[right].enabled === false) continue;
      // Exact duplicates have a separate configuration error. Same-policy
      // nesting remains valid, with independent workspace records.
      if (roots[left] === roots[right] || workspaces[left].readOnly === workspaces[right].readOnly) continue;
      if (within(roots[left], roots[right]) || within(roots[right], roots[left])) {
        throw new AppError('CONFIG_ERROR', 'Nested workspace roots must use the same readOnly setting. Use separate non-overlapping roots for different access policies.');
      }
    }
  }
}
