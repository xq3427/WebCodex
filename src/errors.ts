export class AppError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); this.name = 'AppError'; }
}

export type MissingWorkspacePathReason = 'parent_not_found' | 'target_not_found';
export interface ErrorRecovery {
  action: string;
  instruction: string;
  tools: string[];
}
export interface ToolErrorResult {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    reason?: MissingWorkspacePathReason;
    /** Whether the unchanged request may be retried without a recovery step. */
    retryable: boolean;
    recovery: ErrorRecovery;
  };
}

// Preserve native ENOENT for internal callers, without exporting error.path or
// attaching caller-controlled filesystem details to the public response.
const missingPaths = new WeakMap<object, { reason: MissingWorkspacePathReason; write: boolean }>();
export function markMissingWorkspacePath<T>(error: T, reason: MissingWorkspacePathReason, write = false): T {
  if (error && typeof error === 'object' && (error as unknown as NodeJS.ErrnoException).code === 'ENOENT') {
    missingPaths.set(error, { reason, write });
  }
  return error;
}

function recoveryFor(code: string, missing?: { reason: MissingWorkspacePathReason; write: boolean }): ErrorRecovery {
  if (code === 'NOT_FOUND' && missing?.reason === 'parent_not_found') {
    return missing.write
      ? { action: 'inspect_parent_directory', instruction: 'Check the requested relative path and its existing parent with fs_list. For a write already authorized by the current task, create the required missing parent directories with fs_mkdir before retrying.', tools: ['fs_list', 'fs_mkdir'] }
      : { action: 'verify_parent_path', instruction: 'Check the requested relative path and its existing parent with fs_list. Reading a missing path does not require creating directories.', tools: ['fs_list'] };
  }
  switch (code) {
    case 'NOT_FOUND':
      return { action: 'verify_target_path', instruction: 'Check the requested workspace-relative file or directory path with fs_list. Correct a missing or mistaken target before retrying.', tools: ['fs_list'] };
    case 'DEVICE_MISMATCH':
      return { action: 'verify_device', instruction: 'Read system_status and verify the intended device and connection. Do not substitute another device ID just to make the request succeed.', tools: ['system_status'] };
    case 'WORKSPACE_NOT_FOUND':
      return { action: 'select_authorized_workspace', instruction: 'Use workspace_list to select the intended existing authorized workspace_id. A path or display name does not grant access to another project.', tools: ['workspace_list'] };
    case 'WORKSPACE_DISABLED':
      return { action: 'inspect_workspace_policy', instruction: 'Check workspace_list and workspace_health. This workspace is disabled; do not repeat the operation or change its local policy through tool input.', tools: ['workspace_list', 'workspace_health'] };
    case 'WORKSPACE_UNAVAILABLE':
      return { action: 'inspect_workspace_health', instruction: 'Check workspace_health. Retry only after the intended directory is available and its workspace identity is confirmed; do not redirect the operation to another directory.', tools: ['workspace_health'] };
    case 'WORKSPACE_RESTART_REQUIRED':
      return { action: 'check_workspace_before_restart', instruction: 'Check workspace_health and confirm the intended directory has returned. Use the existing local restart procedure before retrying; do not rebind the workspace to a different directory.', tools: ['workspace_health'] };
    case 'WORKSPACE_IDENTITY_MISMATCH':
      return { action: 'verify_workspace_identity', instruction: 'Check workspace_health and stop using the stale workspace binding. Confirm the intended directory locally before continuing; do not automatically rebind it or reuse old mutation receipts.', tools: ['workspace_health'] };
    case 'READ_ONLY':
      return { action: 'inspect_workspace_write_policy', instruction: 'This workspace permits reads only. Check workspace_list to verify the intended workspace policy; do not retry the write or change permissions automatically.', tools: ['workspace_list'] };
    case 'VERSION_CONFLICT':
      return { action: 'reread_and_replan', instruction: 'Read the current file or checkpoint and review the intended change against its latest hash. Build a new request from that state; do not blindly overwrite it or reuse the stale request.', tools: ['fs_read', 'checkpoint_read'] };
    case 'PATCH_CONFLICT':
    case 'FILE_CHANGED':
      return { action: 'reread_and_replan', instruction: 'Read the current file and review its contents and hash before preparing a new operation. Do not replay the stale change.', tools: ['fs_read'] };
    case 'TASK_REVISION_CONFLICT':
      return { action: 'reread_task_revision', instruction: 'Read the latest task revision, reconcile the current notes, and use its revision number for a new checkpoint request.', tools: ['task_read'] };
    case 'BATCH_PLAN_CONFLICT':
      return { action: 'preview_batch_again', instruction: 'Review the current files and preview the intended batch again. Use the newly verified plan hash for a new apply request.', tools: ['fs_batch_preview'] };
    case 'EXECUTION_DISABLED':
      return { action: 'inspect_execution_policy', instruction: 'Execution is disabled by local policy. Inspect system_status or workspace_list and continue with available file or context tools; do not change execution policy through tool input.', tools: ['system_status', 'workspace_list'] };
    case 'PATH_DENIED':
      return { action: 'verify_allowed_relative_path', instruction: 'Verify the intended authorized workspace and use an allowed relative path. Protected paths, links and workspace boundaries remain enforced.', tools: ['workspace_list'] };
    case 'NOT_DIRECTORY':
      return { action: 'verify_directory_path', instruction: 'Check the existing path with fs_list and select a directory where required. Do not replace a file with a directory automatically.', tools: ['fs_list'] };
    case 'ACCESS_DENIED':
      return { action: 'inspect_existing_access', instruction: 'Check the authorized workspace health and local access state before retrying. Do not change permissions automatically.', tools: ['workspace_health'] };
    case 'FILE_BUSY':
      return { action: 'inspect_busy_file', instruction: 'Check whether the file is still busy and verify its current state before deciding whether to retry the operation.', tools: ['workspace_health'] };
    default:
      return { action: 'inspect_local_diagnostics', instruction: 'Inspect safe local diagnostics and the current operation state before retrying. Do not replay uncertain mutations with a new operation ID.', tools: ['system_status'] };
  }
}

export function errorResult(error: unknown): ToolErrorResult {
  const missing = error && typeof error === 'object' ? missingPaths.get(error) : undefined;
  if (error instanceof AppError) return { ok: false, error: { code: error.code, message: error.message, details: error.details, retryable: false, recovery: recoveryFor(error.code) } };
  const code = (error as NodeJS.ErrnoException)?.code;
  const known: Record<string, string> = { ENOENT: 'NOT_FOUND', EACCES: 'ACCESS_DENIED', EPERM: 'ACCESS_DENIED', EEXIST: 'ALREADY_EXISTS', EBUSY: 'FILE_BUSY' };
  const publicCode = code && Object.hasOwn(known, code) ? known[code]! : 'INTERNAL_ERROR';
  return { ok: false, error: {
    code: publicCode,
    message: publicCode === 'NOT_FOUND' && missing
      ? missing.reason === 'parent_not_found' ? 'A required parent directory was not found.' : 'The requested file or directory was not found.'
      : publicCode !== 'INTERNAL_ERROR' ? 'The requested operation could not be completed (' + code + ').' : 'Operation failed. Check local diagnostics.',
    ...(publicCode === 'NOT_FOUND' && missing ? { reason: missing.reason } : {}),
    retryable: false,
    recovery: recoveryFor(publicCode, publicCode === 'NOT_FOUND' ? missing : undefined),
  } };
}
