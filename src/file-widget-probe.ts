import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { App } from './app.js';
import { AppError, errorResult } from './errors.js';
import { FILE_WIDGET_URI, FILE_WIDGET_MIME_TYPE, LEGACY_FILE_WIDGET_URIS, renderFileWidget } from './file-widget.js';
import { originalFileLimits } from './file-transfer.js';
import { toolErrorSchema } from './tool-output-schema.js';
import { FILE_ROUTES } from './file-routing.js';

export { DEFAULT_WIDGET_UPLOAD_BYTES, MAX_WIDGET_UPLOAD_BYTES } from './file-transfer.js';

/** Original-file component entry and diagnostic probe. The host handles original-file uploads. */
export function registerFileWidgetProbe(server: McpServer, app: App) {
  const widgetUris = new Set<string>([FILE_WIDGET_URI, ...LEGACY_FILE_WIDGET_URIS]);
  const readWidgetResource = (requestedUri: string) => ({
    contents: [{ uri: requestedUri, mimeType: FILE_WIDGET_MIME_TYPE, text: renderFileWidget(), _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
      'openai/widgetDescription': 'Original-file transfer progress and host capability diagnostics. Authorized fs_open_file requests automatically upload once and attempt a file reference only where declared by the host. If handoff_status is host_file_reference_not_declared, the default automatic route is blocked: do not keep waiting or repeat uploads. The component may offer a separate manual one-shot compatibility experiment for an initialized host with an empty modality declaration; it reuses the upload receipt and does not prove model access. An upload is not proof of attachment or model access.',
      'openai/widgetPrefersBorder': true,
      'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
    } }],
  });
  let resourceIndex = 0;
  for (const uri of widgetUris) {
    server.registerResource(resourceIndex++ === 0 ? 'file-widget-prototype' : `file-widget-legacy-${resourceIndex - 1}`,
      uri, { mimeType: FILE_WIDGET_MIME_TYPE }, async requestedUri => readWidgetResource(requestedUri.toString()));
  }
  const localFields = {
    workspace_id: z.string().min(1).max(64).describe('Authorized workspace_id from workspace_list.'),
    path: z.string().min(1).max(2048).describe('Path relative to the selected authorized workspace.'),
    expected_device_id: z.string().uuid().describe('Intended device_id from system_status; required for local file bytes.'),
  };
  const localSchema = z.object(localFields).strict();
  for (const toolName of ['fs_open_file', 'file_widget_probe'] as const) {
  const openFile = toolName === 'fs_open_file';
  server.registerTool(toolName, {
    title: openFile ? 'Experimental original-file component' : 'Check file host capabilities',
    description: openFile
      ? FILE_ROUTES.pdf + ' Open the original-file component for an authorized local file. Retained for explicitly requested component experiments. Do not automatically route document requests to this experiment. Preserves the complete original bytes and filename; no local extraction, OCR or conversion. Requires workspace_id, relative path and intended expected_device_id. The initial response contains no file bytes: the component retrieves bounded chunks privately. By default the component automatically uploads once and sends the original file reference to continue the user request where the host supports it. Follow data.ui.mode: manual configuration retains upload/send buttons. Do not request extra user clicks during the automatic flow. The initial upload flag is only a tool-invocation snapshot; use later component status. Upload or a file-reference acknowledgment does not prove parsing. Never claim a summary from metadata. This host integration is experimental; existing inline limits still apply. If handoff_status is host_file_reference_not_declared, the host has not declared the required resourceLink modality: report the automatic route as blocked, not as a proven host rejection. Only where offered by the component, a separate manual one-shot compatibility test can observe actual acceptance or rejection; do not trigger repeated uploads or claim that an ACK proves file access. If the host rejects the file reference or contents remain inaccessible, report the actual host response; do not repeat uploads, send Base64 messages or substitute local extraction.'
      : FILE_ROUTES.pdf + ' Diagnose experimental ChatGPT file-component support. With no arguments, inspect the visible host capability summary without selecting or uploading a file. The browser component distinguishes missing, empty and declared message/updateModelContext modalities and attempts to publish kind:webcodex_host_capabilities for future turns. These runtime fields are not present in the initial server result; do not infer lack of host capabilities from that absence or repeatedly call the probe. API availability does not prove model access. This tool is only an explicit diagnostic. Legacy local-file mode accepts workspace_id, relative path and expected_device_id together. The opening response has no original bytes; component-only chunk calls use hidden metadata. Existing inline limits apply. No automatic upload, attachment, model invocation or format conversion. The user clicks upload and verifies current-conversation attachment separately.',
    inputSchema: openFile ? localSchema : localSchema.partial(),
    outputSchema: {
      ok: z.boolean(),
      source: z.object({ device_id: z.string(), device_name: z.string(), instance_id: z.string() }),
      data: z.object({
        prototype: z.literal(true), mode: z.enum(['capabilities', 'local-file']),
        max_upload_bytes: z.number().int().positive().describe('Component upload policy only; does not raise local read limits or prove host acceptance.'),
        inline_max_bytes: z.number().int().positive().describe('Configured local inline original-byte read limit.'),
        max_upload_bytes_scope: z.literal('component_upload_policy'),
        snapshot_cache_max_bytes: z.number().int().positive(),
        effective_local_file_max_bytes: z.number().int().positive().describe('Local component single-file maximum with no occupied snapshots: minimum of inline, upload policy and cache limits.'),
        effective_local_file_limit_scope: z.literal('per_file_with_empty_cache'),
        host_upload_support: z.literal('unverified'), client_attachment_support: z.literal('unverified'),
        content_processing: z.literal('none'), content_processing_scope: z.literal('server_only'),
        model_access: z.literal('unverified'), upload_performed: z.literal(false),
        upload_state_scope: z.literal('tool_invocation_snapshot'),
        delivery: z.literal('component-only-chunks'),
        ui: z.object({ mode: z.enum(['automatic', 'manual']), compact: z.boolean(), close_after_send: z.boolean() }),
        next_step: z.string(),
        workspace_id: z.string().optional(), workspace_uid: z.string().optional(), workspace_name: z.string().optional(),
        delivery_id: z.string().uuid().optional(),
        path: z.string().optional(), name: z.string().optional(), size_bytes: z.number().int().nonnegative().optional(),
        sha256: z.string().optional(), mime_type: z.string().optional(),
      }).optional(),
      error: toolErrorSchema.optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      ui: { resourceUri: FILE_WIDGET_URI, visibility: ['model', 'app'] },
      'openai/outputTemplate': FILE_WIDGET_URI, 'openai/widgetAccessible': true,
      'openai/toolInvocation/invoking': openFile ? 'Preparing original file' : 'Preparing file upload check',
      'openai/toolInvocation/invoked': openFile ? 'Original file ready in component' : 'Check upload support in the component',
    },
  }, async (input: Partial<z.infer<typeof localSchema>>) => {
    try {
      return await app.runTool(async () => {
        try {
        const localFile = openFile || input.workspace_id !== undefined || input.path !== undefined;
        if (localFile && (!input.workspace_id || !input.path || !input.expected_device_id)) {
          throw new AppError('INVALID_ARGUMENT', 'Local-file mode requires workspace_id, path and expected_device_id together. Use no arguments for host capability checks.');
        }
        if (input.expected_device_id !== undefined && input.expected_device_id !== app.identity.deviceId) {
          throw new AppError('DEVICE_MISMATCH', 'The request targets a different device. Check system_status and select the intended connection.');
        }
        const limits = originalFileLimits(app.config.limits);
        const common = {
          prototype: true as const, ...limits,
          host_upload_support: 'unverified' as const, client_attachment_support: 'unverified' as const,
          content_processing: 'none' as const, content_processing_scope: 'server_only' as const,
          model_access: 'unverified' as const, upload_performed: false as const,
          upload_state_scope: 'tool_invocation_snapshot' as const, delivery: 'component-only-chunks' as const,
          ui: openFile ? {
            mode: app.config.fileWidget?.mode ?? 'automatic',
            compact: app.config.fileWidget?.compact ?? true,
            close_after_send: app.config.fileWidget?.closeAfterSend ?? true,
          } : { mode: 'manual' as const, compact: false, close_after_send: false },
        };
        if (!localFile) {
          const result = { ok: true, source: app.source(), data: { ...common, mode: 'capabilities' as const,
            next_step: 'This is the initial server snapshot, not a measurement of browser host capabilities. Inspect the component capability summary for initialization, message and update_model_context declarations. The component attempts to publish a later model-context snapshot with kind:webcodex_host_capabilities; it applies to future turns and is not guaranteed to appear in this immediate answer. Use that snapshot when present. Do not infer missing host capabilities from fields absent in this initial server result, and do not repeat tool calls to wait for them. Capability inspection does not require selecting or uploading any file. An empty modality declaration leaves file-reference support unverified; the default file-reference flow requires an explicit resourceLink declaration.',
          } };
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
        }
        // Reuse the original-byte reader's identity, path, protected-file and race checks.
        let original: Awaited<ReturnType<App['fileTransfers']['read']>>;
        try { original = await app.fileTransfers.read({ workspace_id: input.workspace_id!, path: input.path! }); }
        catch (error) {
          if (error instanceof AppError && error.code === 'FILE_TOO_LARGE') {
            throw new AppError(error.code, 'The complete local file exceeds this component route limit; no file was delivered. Component upload policy does not raise local file limits.', { ...(error.details as object), ...limits, limit: limits.effective_local_file_max_bytes });
          }
          throw error;
        }
        const info = original.data;
        if (info.size_bytes > limits.max_upload_bytes) throw new AppError('FILE_TOO_LARGE', 'The file exceeds the configured component upload policy; no file was returned to the component.', { size_bytes: info.size_bytes, ...limits, limit: limits.effective_local_file_max_bytes });
        const workspace = app.ctx.paths.get(input.workspace_id!);
        const workspaceSource = app.identity.workspaceSource(input.workspace_id!);
        const deliveryId = randomUUID();
        const result = { ok: true, source: app.source(), data: {
          ...common, mode: 'local-file' as const,
          delivery_id: deliveryId,
          workspace_id: info.workspace_id, workspace_uid: workspaceSource.workspace_uid, workspace_name: workspace.name,
          path: info.path, name: info.name, size_bytes: info.size_bytes, sha256: info.sha256, mime_type: info.mime_type,
          next_step: 'The component will retrieve the complete original file using private, bounded chunk calls. This response contains no original bytes. upload_performed:false is a tool-invocation snapshot, not the live upload status. '
            + (common.ui.mode === 'automatic'
              ? 'The component automatically uploads once and sends a file reference where the host supports it. Follow the latest handoff_status: host_file_reference_not_declared means the automatic route is blocked, not still waiting. It is not proof of host rejection. A separately selected manual compatibility test may reuse the existing upload receipt once where offered; report its actual outcome without repeating uploads. Continue the original request only when contents become accessible, without asking for upload/send clicks. '
              : 'Manual mode uploads after a user click and offers Send to GPT to deliver a file reference where the host supports it. ')
            + 'Use the latest component state instead of repeating this initial upload flag. Server-side content_processing:none means no local conversion, not that ChatGPT cannot parse the file. File upload and sending a reference are separate from actual model access; answer from accessible original contents, never from metadata, and do not silently substitute text extraction or repeat file-opening calls.',
        } };
        let delivery: Awaited<ReturnType<App['fileWidgetDeliveries']['prepare']>>;
        try { delivery = await app.fileWidgetDeliveries.prepare(original); }
        catch (error) {
          if (error instanceof AppError && error.code === 'FILE_WIDGET_CACHE_FULL') {
            throw new AppError(error.code, 'The component snapshot cache cannot hold this file now. The effective local limit assumes an empty cache; active snapshots can reduce available capacity.', { size_bytes: info.size_bytes, ...limits });
          }
          throw error;
        }
        app.store.audit(toolName, info.workspace_id, { path: info.path, size_bytes: info.size_bytes, sha256: info.sha256 });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result,
          _meta: { webcodexDelivery: { deliveryId, ticketId: delivery.ticket_id, expiresAt: delivery.expires_at, chunkMaxBytes: delivery.chunk_max_bytes } },
        };
        } catch (error) {
          app.store.audit('tool_error', input.workspace_id ?? null, { tool: toolName, code: errorResult(error).error.code });
          throw error;
        }
      });
    } catch (error) {
      const result = { ...errorResult(error), source: app.source() };
      // Errors contain no file bytes or host credentials; shutdown has already closed the store.
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    }
  });
  }
  const deliveryInput = {
    ticket_id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expected_device_id: z.string().uuid(),
  };
  for (const name of ['file_widget_read', 'file_widget_release'] as const) {
    const read = name === 'file_widget_read';
    server.registerTool(name, {
      title: read ? 'Receive original file chunk' : 'Release original file snapshot',
      description: read ? 'Component-only original-byte transport. Requires a short-lived capability ticket and intended device. Returns at most the configured chunk size in hidden metadata; never request this tool from the model.'
        : 'Component-only cleanup for an original-file snapshot. Releases its memory without modifying the source file.',
      inputSchema: z.object(read ? { ...deliveryInput, offset: z.number().int().nonnegative() } : deliveryInput).strict(),
      outputSchema: {
        ok: z.boolean(), source: z.object({ device_id: z.string(), device_name: z.string(), instance_id: z.string() }),
        data: z.unknown().optional(), error: toolErrorSchema.optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
    }, async (input: { ticket_id: string; expected_device_id: string; offset?: unknown }) => {
      try {
        return await app.runTool(async () => {
          try {
            const chunk = read ? await app.fileWidgetDeliveries.read({ ...input, offset: z.number().int().nonnegative().parse(input.offset) }) : undefined;
            const data = chunk ? chunk.data : await app.fileWidgetDeliveries.release(input);
            const result = { ok: true, source: app.source(), data };
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result,
              ...(chunk ? { _meta: { webcodexChunk: { base64: chunk.base64 } } } : {}),
            };
          } catch (error) {
            app.store.audit('tool_error', null, { tool: name, code: errorResult(error).error.code });
            throw error;
          }
        });
      } catch (error) {
        const result = { ...errorResult(error), source: app.source() };
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  }
}
