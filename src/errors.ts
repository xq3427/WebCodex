import { MODEL_RELAY_GUIDANCE } from './file-routing.js';

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

function recoveryFor(code: string, missing?: { reason: MissingWorkspacePathReason; write: boolean }, details?: unknown): ErrorRecovery {
  if (code === 'NOT_FOUND' && missing?.reason === 'parent_not_found') {
    return missing.write
      ? { action: 'inspect_parent_directory', instruction: 'Check the requested relative path and its existing parent with fs_list. For a write already authorized by the current task, create the required missing parent directories with fs_mkdir before retrying.', tools: ['fs_list', 'fs_mkdir'] }
      : { action: 'verify_parent_path', instruction: 'Check the requested relative path and its existing parent with fs_list. Reading a missing path does not require creating directories.', tools: ['fs_list'] };
  }
  switch (code) {
    case 'COPY_SAME_PATH':
      return { action: 'choose_distinct_copy_destination', instruction: 'The source and destination refer to the same local file. Verify the intended workspace and choose a different authorized destination; this copy made no changes.', tools: ['workspace_list', 'fs_stat'] };
    case 'SOURCE_VERSION_CONFLICT':
      return { action: 'inspect_copy_source_version', instruction: 'The source changed before this copy committed. Read its current SHA-256 with fs_stat and inspect the original fs_copy operation_status before deciding on a new operation. Do not substitute a guessed hash or replay an uncertain copy.', tools: ['fs_stat', 'operation_status'] };
    case 'FILE_IMPORT_PROXY_INVALID':
      return { action: 'inspect_local_proxy', instruction: 'The configured local tunnel.proxyUrl is invalid for file downloads. Inspect that setting locally; do not change file references or expose proxy details through the conversation.', tools: ['system_status'] };
    case 'FILE_WRITE_VERIFICATION_FAILED':
      return { action: 'inspect_uncertain_file_save', instruction: 'The destination may already have changed, but final byte verification failed. Inspect operation_status with the original tool and operation key, then fs_stat and linked change IDs before any further write. Do not automatically overwrite or restore uncertain state.', tools: ['operation_status', 'fs_stat', 'changes_list'] };
    case 'FILE_IMPORT_ORIGINAL_MISMATCH':
      return { action: 'report_original_file_mismatch', instruction: 'The downloaded bytes did not match the supplied original source size/SHA-256, so this attempt did not write the destination. Inspect fs_save_file_status or operation_status with the original key. Do not replace the expected source hash with the received hash, use an old attachment, regenerate the artifact or replay with a new key. Verify the actual host reference belongs to the same original file.', tools: ['fs_save_file_status', 'operation_status', 'fs_stat'] };
    case 'FILE_OPERATION_RETRY_LIMIT':
    case 'FILE_IMPORT_CONTENT_CHANGED':
      return { action: 'inspect_file_operation', instruction: 'This import cannot be retried safely under its existing attempt budget or content identity. Inspect operation_status with the original tool/key and report its state. Do not use a new key to bypass this failure or expose signed URLs.', tools: ['operation_status'] };
    case 'EXECUTION_UNKNOWN':
      return { action: 'inspect_uncertain_operation', instruction: 'The previous operation may have changed local state. For single-file writes inspect operation_status with the original tool and key; for batches use fs_batch_status. For commands inspect exec_list and the original job with exec_poll. Never replay an uncertain mutation with a new key.', tools: ['operation_status', 'fs_batch_status', 'exec_list', 'exec_poll'] };
    case 'FILE_IMPORT_SOURCE_DENIED':
      if (details && typeof details==='object' && 'reason' in details && details.reason==='local_file_reference') return {action:'copy_local_source',instruction:'This input is a local file reference, not a remote download. The import was rejected before writing. For an authorized local copy use workspace_list and fs_stat to identify the source, then fs_copy with source and destination workspace-relative paths. No URL, upload or command execution is needed. Inspect operation_status if any earlier write outcome was uncertain.',tools:['workspace_list','fs_stat','fs_copy','operation_status']};
      if (details && typeof details==='object' && 'reason' in details && details.reason==='sandbox_reference') return {action:'transfer_existing_sandbox_bytes',instruction:MODEL_RELAY_GUIDANCE+' fs_import_file received a sandbox reference and rejected it before writing. First inspect operation_status with tool=fs_import_file and the original key; never change routes while an earlier write is unknown. After a definite failed import, use system_status for chunk limits and fs_stat for the current destination hash. Only if complete original slices and hashes fit host output/tool limits without truncation, use fs_write_binary_chunk; overwrite uses the destination hash as expected_sha256, not null or the source hash. This import rejection does not show a chunk attempt failed. If the source is already local, use fs_copy. Never resize, lower quality, reencode, regenerate or guess bytes. If original bytes or the chunk tool are unavailable, report that specific limitation; do not retry the importer.',tools:['operation_status','system_status','fs_stat','fs_write_binary_chunk','fs_write_binary_status','fs_copy']};
      return {action:'inspect_download_source_policy',instruction:MODEL_RELAY_GUIDANCE+' This is WebCodex fs_import_file download-source policy, not a local write-permission error or host tool-dispatch block. Report only details.stage/reason, without the URL/file ID. Inspect operation_status with tool=fs_import_file and the original key. After a definite failed import, use system_status for chunk limits and fs_stat for the destination hash. Only if complete original slices and hashes fit host output/tool limits without truncation, use fs_write_binary_chunk; overwrite requires the current destination hash, not null or the source hash. The rejected import did not attempt chunk writeback. Never resize, lower quality, reencode, regenerate or guess bytes. For an already local source use fs_copy. Do not change allowed hosts, DNS or proxy settings, or fetch the rejected URL via execution. If the original bytes or chunk tool are unavailable, report that specific limitation instead of retrying import.',tools:['operation_status','system_status','fs_stat','fs_write_binary_chunk','fs_write_binary_status','fs_copy']};
    case 'FILE_IMPORT_INVALID_ARGUMENT':
      return {action:'use_actual_file_bytes_or_reference',instruction:MODEL_RELAY_GUIDANCE+' fs_import_file requires a real host download object; a sandbox path is insufficient. fs_write_binary_chunk is only available as a fallback when complete original slices and hashes can be relayed as tool arguments without truncation. Inspect any uncertain prior operation first, then system_status for limits and fs_stat for the current destination hash before overwriting. Only transfer exact original bytes and independent hashes actually obtained from Code Interpreter. Never invent bytes, URLs or IDs, resize, reencode or regenerate the file. If original bytes or the chunk tool are unavailable, report that limitation instead of repeating import.',tools:['operation_status','system_status','fs_stat','fs_write_binary_chunk','fs_write_binary_status']};
    case 'BINARY_INPUT_INVALID':
    case 'BINARY_INPUT_INTEGRITY_ERROR':
      return {action:'read_original_bytes_again',instruction:'This input was rejected before writing the destination. Obtain canonical Base64, byte length and SHA-256 from the same existing source bytes. Never repair guessed Base64 or replace the expected original digest with a hash of corrupted input. Do not regenerate the file. Report failure if the complete payload cannot be obtained.',tools:['fs_write_binary']};
    case 'BINARY_INPUT_TOO_LARGE':
      return {action:'inspect_inline_binary_limit',instruction:'Inspect system_status and the reported whole-file/chunk limit. If only a message or chunk is too large and the whole file fits, read the indicated original slice and use fs_write_binary_chunk. Otherwise report the whole-file limit; never resize, downsample, lower quality, reencode, regenerate, truncate, change policy or split into separate files to bypass it. Do not request a URL. Server limits do not guarantee that ChatGPT can relay this much text.',tools:['system_status','fs_write_binary_chunk']};
    case 'BINARY_CHUNK_ORDER':
    case 'BINARY_CHUNK_CONFLICT':
    case 'BINARY_CHUNK_INVALID':
    case 'BINARY_CHUNK_INTEGRITY_ERROR':
      return {action:'inspect_binary_transfer',instruction:'Inspect fs_write_binary_status with the original key. Continue only while status=receiving, from next_offset, or resend retry_chunk_offset/retry_chunk_bytes when resume_action=repeat_last_chunk. Read Base64 and chunk SHA-256 from the unchanged source. Never replace the whole-file hash, reorder data, or claim saved while receiving. Failed/unknown writes must not be replayed; inspect operation_status with tool=fs_write_binary.',tools:['fs_write_binary_status','operation_status']};
    case 'BINARY_CHUNK_CAPACITY':
    case 'BINARY_CHUNK_EXPIRED':
      return {action:'inspect_binary_cache',instruction:'Inspect fs_write_binary_status and local limits. This transfer cannot continue under its current staging state. Do not raise quotas or bypass expiry with blind new keys; verify whether a final write occurred before planning another transfer.',tools:['fs_write_binary_status','system_status']};
    case 'BINARY_CHUNK_BUSY':
      return {action:'inspect_active_binary_transfer',instruction:'A chunk transfer is already committing. Inspect fs_write_binary_status with its original key; do not start another transfer or replay an unknown final write.',tools:['fs_write_binary_status','operation_status']};
    case 'FILE_IMPORT_DOWNLOAD_FAILED':
    case 'FILE_IMPORT_TIMEOUT':
    case 'FILE_IMPORT_INTEGRITY_ERROR':
      return { action: 'inspect_import_retry', instruction: 'No file was committed by this failed download. Inspect operation_status with tool=fs_import_file and the original key. Retry only if its retryable field is true, preserving file_id, destination, expected hash and key; the host may renew download_url. Stop at the attempt limit. Never expose signed URLs or bypass the journal with a new key.', tools: ['operation_status'] };
    case 'FILE_IMPORT_TOO_LARGE':
      return { action: 'inspect_binary_write_limit', instruction: 'The original exceeds limits.binaryWriteMaxBytes; no partial file is saved. Report its limit and do not split or truncate the file to bypass local policy.', tools: ['system_status'] };
    case 'FILE_IMPORT_BUSY':
      return { action: 'inspect_active_import', instruction: 'A different import is active. Check the original operation with operation_status and allow the active import to finish. A capacity rejection does not reserve this key; retry it after capacity is available, without launching parallel retries.', tools: ['operation_status'] };
    case 'DOCUMENT_READ_LIMIT':
      return { action: 'report_document_pending', instruction: 'The bounded PDF status-read budget is exhausted. Report the component progress and stop automatic polling. A pending state has no readable page text; do not reopen documents to bypass the limit.', tools: [] };
    case 'DOCUMENT_EXPIRED':
    case 'DOCUMENT_NOT_FOUND':
      return { action: 'report_unavailable_document', instruction: 'The PDF snapshot is unavailable or expired. Report the failure; a later user-requested read may open a new snapshot using document_open. Never reuse stale component credentials.', tools: ['document_open'] };
    case 'DOCUMENT_PAGE_RANGE':
      return { action: 'check_pdf_page_range', instruction: 'Use total_pages from the previous ready result and request a valid page range. Do not substitute another document.', tools: ['document_read'] };
    case 'PDF_INVALID':
    case 'PDF_PASSWORD_REQUIRED':
    case 'PDF_PARSE_FAILED':
    case 'PDF_LIMIT':
    case 'FILE_INTEGRITY_ERROR':
    case 'ASSET_UNAVAILABLE':
    case 'DOCUMENT_UNSUPPORTED':
    case 'DOCUMENT_CAPACITY':
    case 'DOCUMENT_ACCESS_DENIED':
    case 'DOCUMENT_STALE_SUBMISSION':
    case 'DOCUMENT_INVALID_RESULT':
    case 'DOCUMENT_TEXT_LIMIT':
    case 'DOCUMENT_INVALID_ARGUMENT':
    case 'DOCUMENT_RESULT_CONFLICT':
    case 'DOCUMENT_CACHE_LIMIT':
    case 'DOCUMENT_JOB_LIMIT':
    case 'DOCUMENT_ASSET_INVALID':
    case 'DOCUMENT_ASSET_LIMIT':
    case 'DOCUMENT_ASSET_UNAVAILABLE':
      return { action: 'report_pdf_read_failure', instruction: 'Report the actual PDF/component error and page coverage. Do not claim unread contents, automatically retry failed submissions, expose private metadata or change local policy.', tools: [] };
    case 'RELAY_TIMEOUT':
      return { action: 'inspect_component_relay', instruction: 'The synthetic browser component did not return text within this read. Report this error and the component phase/code; do not claim model access, calculate the answer or automatically open and retry more probes.', tools: [] };
    case 'RELAY_READ_LIMIT':
      return { action: 'report_probe_not_ready', instruction: 'The bounded pending-read budget has been exhausted without actual component text. Report that this attempt did not establish model access and inspect the component phase/code. Do not keep polling, calculate an answer or open new probes to bypass the budget.', tools: [] };
    case 'RELAY_EXPIRED':
    case 'RELAY_NOT_FOUND':
    case 'RELAY_CLOSED':
      return { action: 'report_unavailable_probe', instruction: 'This synthetic probe is no longer available, for example after expiry or service shutdown. Report the actual failure. A new explicitly requested diagnostic uses a new reading_probe_open result; do not reuse its old component credentials.', tools: ['reading_probe_open'] };
    case 'RELAY_CANCELLED':
    case 'RELAY_BUSY':
    case 'RELAY_CAPACITY':
    case 'RELAY_ACCESS_DENIED':
    case 'RELAY_STALE_SUBMISSION':
    case 'RELAY_INVALID_CONTENT':
    case 'RELAY_PAYLOAD_TOO_LARGE':
    case 'RELAY_INVALID_ARGUMENT':
      return { action: 'report_probe_failure', instruction: 'Report the actual synthetic relay error. Do not expose component credentials, substitute another probe, calculate an answer or automatically replay submissions.', tools: [] };
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
      return { action: 'reread_and_replan', instruction: 'Inspect the current file (fs_stat for binaries) or checkpoint and review the intended change against its latest hash. Build a new request from that state; do not blindly overwrite it or reuse the stale request.', tools: ['fs_read', 'fs_stat', 'checkpoint_read'] };
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
      return { action: 'inspect_existing_access', instruction: 'The operating system denied access for the account running WebCodex. Check workspace_health, then run the local `webcodex-mcp access check` or dashboard permission test on that computer. trusted-host/all does not elevate the process or override NTFS, share, mount or administrator permissions. Restart WebCodex from the intended account after fixing the OS access; do not keep retrying the write.', tools: ['workspace_health', 'system_status'] };
    case 'FILE_BUSY':
      return { action: 'inspect_busy_file', instruction: 'Check whether the file is still busy and verify its current state before deciding whether to retry the operation.', tools: ['workspace_health'] };
    default:
      return { action: 'inspect_local_diagnostics', instruction: 'Inspect safe local diagnostics and the current operation state before retrying. Do not replay uncertain mutations with a new operation ID.', tools: ['system_status'] };
  }
}

export function errorResult(error: unknown): ToolErrorResult {
  const missing = error && typeof error === 'object' ? missingPaths.get(error) : undefined;
  if (error instanceof AppError) return { ok: false, error: { code: error.code, message: error.message, details: error.details, retryable: false, recovery: recoveryFor(error.code,undefined,error.details) } };
  const code = (error as NodeJS.ErrnoException)?.code;
  const known: Record<string, string> = { ENOENT: 'NOT_FOUND', EACCES: 'ACCESS_DENIED', EPERM: 'ACCESS_DENIED', EROFS: 'ACCESS_DENIED', EEXIST: 'ALREADY_EXISTS', EBUSY: 'FILE_BUSY' };
  const publicCode = code && Object.hasOwn(known, code) ? known[code]! : 'INTERNAL_ERROR';
  return { ok: false, error: {
    code: publicCode,
    message: publicCode === 'NOT_FOUND' && missing
      ? missing.reason === 'parent_not_found' ? 'A required parent directory was not found.' : 'The requested file or directory was not found.'
      : publicCode === 'ACCESS_DENIED'
        ? 'The operating system denied this operation for the account running WebCodex (' + code + '). WebCodex local policy cannot grant NTFS, share, mount or elevated administrator permissions.'
        : publicCode !== 'INTERNAL_ERROR' ? 'The requested operation could not be completed (' + code + ').' : 'Operation failed. Check local diagnostics.',
    ...(publicCode === 'NOT_FOUND' && missing ? { reason: missing.reason } : {}),
    retryable: false,
    recovery: recoveryFor(publicCode, publicCode === 'NOT_FOUND' ? missing : undefined),
  } };
}
