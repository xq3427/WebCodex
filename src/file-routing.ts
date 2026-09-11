export const MODEL_RELAY_GUIDANCE = 'Model-mediated Base64 is an unverified fallback, not reliable large-file transport. chunk_max_bytes is no host guarantee. If Code Interpreter truncates output before MCP submission, stop; that slice was not sent. Do not invent errors, increase chunks, restart services or launch hundreds of smaller chunks to work around truncation.';
export const MODEL_RELAY_POLICY = {
  model_relay_verified: false,
  large_file_model_relay_recommended: false,
  requires_complete_payload_within_host_limits: true,
  server_limit_is_not_host_context_limit: true,
  on_model_output_truncation: 'stop_before_submit',
} as const;

/** Shared model-facing routes; transfer receipts alone never prove document access. */
export const FILE_ROUTES = {
  localCopy: 'Copy existing local files with fs_copy across authorized workspaces; no upload, import, URL, Base64 or execution is needed.',
  text: 'Use fs_read/fs_read_chunk for text inspection and fs_write/fs_apply_patch for text, SVG and code changes.',
  generatedSave: 'fs_save_file resolves a real host file reference privately; never substitute a sandbox path, filename or old attachment ID. Keep its automatic component mounted; query fs_save_file_status within can_poll/poll_limit. Only saved with verified=true and matching fs_stat proves completion. Report missing host authorization; stop on failed/unknown, never replay uncertain writes.',
  pdf: 'For local PDF text reading use document_open then document_read. Only status=ready returns page text. The component verifies the complete original and parses its text layer in the browser; keep it mounted. Report coverage, empty text and truncation. No OCR, diagram understanding or Office parsing is provided.',
  binary: MODEL_RELAY_GUIDANCE + ' Use fs_write_binary_chunk/fs_write_binary_status only when original bytes and hashes fit host output/tool limits. Non-final chunks must equal chunk_max_bytes; only the final may be shorter. Keep original size/hash, chunk hash, destination hash and one key. After lost replies query status; repeat_last_chunk requires the same retry_chunk_offset/retry_chunk_bytes slice and key. fs_write_binary needs complete small payloads. Never resize, downsample, lower quality, reencode, regenerate or guess bytes. Only status=saved and verified=true completes transfer; verify fs_stat. Inspect uncertain operations before new writes. Legacy fs_import_file requires an actual host file object; do not request URLs or use sandbox paths.',
  raw: 'fs_read_file returns original bytes and native PNG/JPEG/GIF/WebP image content. Other binaries depend on host parsing; a card or upload receipt does not prove readable contents. For local copies use fs_copy; do not transfer the source into chat.',
  diagnostic: 'fs_open_file and file_widget_probe are retained for explicit component diagnostics only. Do not route normal PDF analysis to these probes or repeatedly upload inaccessible files.',
} as const;

export const FILE_CAPABILITIES = {
  text: { read: ['fs_read', 'fs_read_chunk'], write: ['fs_write', 'fs_apply_patch'] },
  pdf_text: { open: 'document_open', read: 'document_read', ready_status: 'ready', native_attachment: false, ocr: false },
  binary: { default_write:'fs_save_file', default_write_condition:'actual_host_file_reference_and_original_hash_available', host_file_id_write:'fs_save_file', host_file_id_status:'fs_save_file_status', host_file_id_verified:false, ...MODEL_RELAY_POLICY, chunk_write:'fs_write_binary_chunk',chunk_status:'fs_write_binary_status', inline_write:'fs_write_binary', inspect:'fs_stat', operation_status:'operation_status', import:'fs_import_file', import_is_legacy:true, import_required_for_writeback:false, original_bytes_required:true, overwrite_expected_sha256:'current_destination_hash_not_source_hash', host_forwarding_verified:false, inline_host_verified:false },
  binary_management: { copy: 'fs_copy', cross_workspace_copy: true, copy_status: 'operation_status', execution_required: false, preview: 'fs_batch_preview', apply: 'fs_batch_apply', status: 'fs_batch_status', operations: ['copy', 'move', 'delete'] },
  images: { read:'fs_read_file', default_write:'fs_save_file', host_file_id_status:'fs_save_file_status', host_file_id_verified:false, ...MODEL_RELAY_POLICY, original_bytes_required:true, resize_to_fit_allowed:false, formats:['PNG','JPEG','GIF','WebP'] },
  office_reading: { supported: false },
} as const;
