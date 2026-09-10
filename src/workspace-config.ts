import { createHash } from 'node:crypto';
import path from 'node:path';
import type { WorkspaceConfig } from './types.js';

export type WorkspaceInput = string | {
  root: string; id?: string; uid?: string; name?: string; readOnly?: boolean;
  enabled?: boolean; onUnavailable?: 'error' | 'skip'; executionProfile?: string;
  worktree?: { gitDir: string; commonDir: string };
};

/** UUID v5 in the device namespace. Never depends on array position, display name or state IO. */
export function workspaceDefaults(deviceId: string, canonicalRoot: string): WorkspaceConfig {
  const rootKey = process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot;
  const digest = createHash('sha1')
    .update(Buffer.from(deviceId.replace(/-/g, ''), 'hex'))
    .update('webcodex/workspace/v1\0' + rootKey).digest().subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  const uid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  // Avoid cutting a surrogate pair while staying within the schema's UTF-16 length limit.
  let name = '';
  for (const character of path.basename(canonicalRoot) || 'Workspace') {
    if (name.length + character.length > 120) break;
    name += character;
  }
  return { id: 'ws_' + hex, uid, name, root: canonicalRoot, readOnly: false };
}
