import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { App } from './app.js';
import { AppError, errorResult } from './errors.js';
import { chatGptFileSchema } from './file-import.js';
import { FILE_SAVE_HOST_ERRORS } from './file-save.js';
import { FILE_SAVE_WIDGET_URI, FILE_SAVE_WIDGET_MIME_TYPE, renderFileSaveWidget } from './file-save-widget.js';
import { toolErrorSchema } from './tool-output-schema.js';

export const FILE_SAVE_TOOLS = ['fs_save_file', 'fs_save_file_status', 'file_save_widget_complete', 'file_save_widget_fail'] as const;

/** A host-authorized file reference is resolved privately, never transcribed as Base64. */
export function registerFileSaveTools(server: McpServer, app: App) {
  server.registerResource('file-save', FILE_SAVE_WIDGET_URI, { mimeType: FILE_SAVE_WIDGET_MIME_TYPE }, async uri => ({ contents: [{
    uri: uri.toString(), mimeType: FILE_SAVE_WIDGET_MIME_TYPE, text: renderFileSaveWidget(), _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
      'openai/widgetPrefersBorder': true,
      'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
      'openai/widgetDescription': 'Automatically resolves an already authorized ChatGPT file ID through getFileDownloadUrl and passes the temporary address to the bound private save tool. The server downloads and verifies the complete original before saving. No file picker, upload button, model-visible Base64 or browser network fetch. Awaiting/pending is not saved; use fs_save_file_status for the actual result.',
    },
  }] }));
  const owner = { expected_device_id: z.string().uuid().describe('Intended device_id from system_status; required for every save request and status query.') };
  const workspace = { workspace_id: z.string().min(1).max(64) };
  const key = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
  const sha = z.string().regex(/^[a-f0-9]{64}$/);
  const outputSchema = { ok: z.boolean(), source: z.object({ device_id: z.string(), device_name: z.string(), instance_id: z.string() }), data: z.unknown().optional(), error: toolErrorSchema.optional() };
  const limit = app.config.limits.binaryWriteMaxBytes ?? 33554432;
  function register(name: typeof FILE_SAVE_TOOLS[number], description: string, shape: z.ZodRawShape,
    handler: (input: any) => Promise<{ data: unknown; meta?: Record<string, unknown> }>) {
    const privateTool = name.startsWith('file_save_widget_');
    const readOnly = name === 'fs_save_file_status';
    app.diagnostics.registerTool(name);
    server.registerTool(name, {
      description, inputSchema: z.object({ ...shape, ...owner }).strict(), outputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: name === 'fs_save_file' || name === 'file_save_widget_complete' },
      ...(privateTool ? { _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true } }
        : name === 'fs_save_file' ? { _meta: {
          ui: { resourceUri: FILE_SAVE_WIDGET_URI, visibility: ['model', 'app'] },
          'openai/outputTemplate': FILE_SAVE_WIDGET_URI, 'openai/widgetAccessible': true, 'openai/fileParams': ['file'],
          'openai/toolInvocation/invoking': 'Preparing original file save',
          'openai/toolInvocation/invoked': 'Save prepared; check completion',
        } } : {}),
    }, async input => {
      try {
        return await app.runTool(async () => {
          if (input.expected_device_id !== app.identity.deviceId) throw new AppError('DEVICE_MISMATCH', 'This save targets another device. Check system_status and select the intended connection.');
          const { expected_device_id, ...payload } = input as Record<string, unknown>;
          const { data, meta } = await handler(payload);
          const result = { ok: true, source: app.source(), data };
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, ...(meta ? { _meta: meta } : {}) };
        });
      } catch (error) {
        const result = { ...errorResult(error), source: app.source() };
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  }
  register('fs_save_file', 'Save an existing ChatGPT-generated original file to an authorized local workspace without model-transcribed Base64 or user-supplied URLs. Supply either the real host file_id returned for THIS artifact, or the actual host file object in file (not both). A sandbox:/ path, local path, display name or invented ID cannot authorize a file. Read the same original size_bytes/content_sha256 in Code Interpreter; do not regenerate, resize or reencode it. The automatic component obtains the host download URL privately; the server verifies these exact source bytes before any destination write. The host must authorize this file reference. Keep the component mounted; awaiting_host_file/pending is NOT saved. Query fs_save_file_status within its poll budget; stop at failed/unknown/blocked or exhausted budget. Only saved AND verified=true, followed by matching fs_stat size/hash, prove completion. Before overwrite obtain the current destination hash as expected_sha256; null is create-only. Parents must exist. Reuse one idempotency_key; inspect uncertain previous writes before switching routes. No extension, file picker, manual download URL or public server is needed. Missing host authorization must be reported, never replaced with an uploaded old file ID or a guessed sandbox URL.', {
    ...workspace, path: z.string().min(1).max(2048),
    file_id: z.string().min(1).max(512).optional().describe('Actual host file identifier for this generated artifact, from its tool file reference. Not sandbox:/, a filename or a prior source attachment.'),
    file: chatGptFileSchema.optional(),
    size_bytes: z.number().int().min(0).max(limit), content_sha256: sha,
    expected_sha256: sha.nullable(), idempotency_key: key,
  }, async input => {
    if ((input.file_id !== undefined) === (input.file !== undefined)) throw new AppError('FILE_SAVE_REFERENCE_INVALID', 'Supply exactly one actual host file_id or host file object. Do not invent an ID from a sandbox path.');
    const { file, file_id, ...binding } = input;
    const opened = await app.fileSaves.open({ ...binding, file_id: file ? file.file_id : file_id });
    const statusFields = { status_tool: 'fs_save_file_status' as const,
      status_arguments: { ...opened.data.status_arguments, expected_device_id: app.identity.deviceId } };
    // A native file object may already contain a usable host-issued URL. Keep
    // policy enforcement in FileImportService; this is only route selection.
    let direct = false;
    if (file) {
      try { const url = new URL(file.download_url); direct = url.protocol === 'https:' && url.hostname === 'files.oaiusercontent.com'; } catch { /* Let the widget resolve the real file ID. */ }
    }
    if (direct && opened.meta) return { data: { ...await app.fileSaves.complete({ ticket: opened.meta.webcodexFileSave.ticket, download_url: file.download_url }), ...statusFields } };
    return { data: { ...opened.data, ...statusFields }, ...(opened.meta ? { meta: { webcodexFileSave: opened.meta.webcodexFileSave } } : {}) };
  });
  register('fs_save_file_status', 'Inspect an automatic original-file save using the original workspace and idempotency_key. No network fetch or new write. Pending does not prove that the host granted file access; respect can_poll/poll_limit, allow retry_after_ms without a blocking wait tool, and stop on terminal failure. saved with verified=true includes the receipt and independent disk observation through the import operation; confirm fs_stat matches the expected source. Unknown must not be replayed. Durable writes can also be queried through operation_status with tool=fs_import_file and the SAME key.', {
    ...workspace, idempotency_key: key,
  }, async input => ({ data: await app.fileSaves.status(input) }));
  register('file_save_widget_complete', 'App-only completion of a previously authorized original-file save. The private ticket fixes device/workspace/path/source identity/source hash/size and overwrite precondition. Supply only the temporary URL returned by getFileDownloadUrl. Never expose it to model context. Duplicate requests cannot change the destination or source; inspect public status after an uncertain response.', {
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/), download_url: z.string().min(1).max(16384),
  }, async input => ({ data: await app.fileSaves.complete(input) }));
  register('file_save_widget_fail', 'App-only fixed host file-resolution failure for a private save ticket. Does not write files or override an existing completed/uncertain write. No raw host exception, file ID, URL or credential is accepted.', {
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/), error_code: z.enum(FILE_SAVE_HOST_ERRORS),
  }, async input => ({ data: await app.fileSaves.fail(input) }));
}
