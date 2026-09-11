import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { App } from './app.js';
import { errorResult } from './errors.js';
import { toolErrorSchema } from './tool-output-schema.js';
import { READING_RELAY_URI, renderReadingRelayWidget } from './reading-relay-widget.js';

export const LEGACY_READING_RELAY_URIS = ['ui://webcodex/reading-relay-0.14.0-preview.3.html', 'ui://webcodex/reading-relay-0.14.0-preview.4.html', 'ui://webcodex/reading-relay-0.15.0-preview.1.html', 'ui://webcodex/reading-relay-0.15.0-preview.2.html', 'ui://webcodex/reading-relay-0.15.0-preview.3.html', 'ui://webcodex/reading-relay-0.15.0-preview.4.html', 'ui://webcodex/reading-relay-0.15.0-preview.5.html', 'ui://webcodex/reading-relay-0.15.0-preview.6.html', 'ui://webcodex/reading-relay-0.15.0-preview.7.html', 'ui://webcodex/reading-relay-0.16.0-preview.1.html', 'ui://webcodex/reading-relay-0.16.0-preview.2.html', 'ui://webcodex/reading-relay-0.16.0-preview.3.html', 'ui://webcodex/reading-relay-0.16.0-preview.4.html', 'ui://webcodex/reading-relay-0.16.0-preview.5.html', 'ui://webcodex/reading-relay-0.16.0-preview.6.html'] as const;

export const READING_RELAY_TOOLS = ['reading_probe_open', 'reading_probe_read', 'reading_probe_poll', 'reading_probe_submit'] as const;

/** Synthetic host compatibility experiment. No local file access or attachment APIs. */
export function registerReadingRelayProbe(server: McpServer, app: App) {
  for (const [index, resourceUri] of [READING_RELAY_URI, ...LEGACY_READING_RELAY_URIS].entries()) {
  server.registerResource(index === 0 ? 'reading-relay-probe' : `reading-relay-legacy-${index}`, resourceUri,
    { mimeType: 'text/html;profile=mcp-app' }, async uri => ({ contents: [{
      uri: uri.toString(), mimeType: 'text/html;profile=mcp-app', text: renderReadingRelayWidget(),
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        'openai/widgetPrefersBorder': true,
        'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
        'openai/widgetDescription': 'Automatically prepares and submits synthetic browser-generated text through MCP tools. reading_probe_read returns immediately with pending or ready; it never holds a tool call open waiting for the component. Keep this component mounted until it submits. This checks content relay, not PDF or native attachment support.',
      },
    }] }));
  }

  const relay = { relay_id: z.string().uuid() };
  const privateInput = { ...relay, ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) };
  const outputSchema = {
    ok: z.boolean(), source: z.object({ device_id: z.string(), device_name: z.string(), instance_id: z.string() }),
    data: z.unknown().optional(), error: toolErrorSchema.optional(),
  };
  type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
  function register(name: typeof READING_RELAY_TOOLS[number], description: string, shape: z.ZodRawShape,
    handler: (input: any, extra: Extra) => Promise<{ data: unknown; meta?: Record<string, unknown> }> | { data: unknown; meta?: Record<string, unknown> }) {
    const privateTool = name === 'reading_probe_poll' || name === 'reading_probe_submit';
    app.diagnostics.registerTool(name);
    server.registerTool(name, {
      description, inputSchema: z.object(shape).strict(), outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: name !== 'reading_probe_open', openWorldHint: false },
      ...(privateTool ? { _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true } }
        : name === 'reading_probe_open' ? { _meta: {
          ui: { resourceUri: READING_RELAY_URI, visibility: ['model', 'app'] },
          'openai/outputTemplate': READING_RELAY_URI, 'openai/widgetAccessible': true,
          'openai/toolInvocation/invoking': 'Preparing content relay check',
          'openai/toolInvocation/invoked': 'Component prepared; content not yet returned',
        } } : {}),
    }, async (input, extra) => {
      try {
        return await app.runTool(async () => {
          const { data, meta } = await handler(input, extra);
          const result = { ok: true, source: app.source(), data };
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result,
            ...(meta ? { _meta: meta } : {}) };
        });
      } catch (error) {
        const result = { ...errorResult(error), source: app.source() };
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  }

  // App-wide state survives stateless HTTP's per-POST MCP server instances. This
  // single-owner prototype has no chat identity; the opaque ticket guards submission.
  const binding = app.instanceId;
  register('reading_probe_open', 'Explicit synthetic diagnostic only: open an automatic browser component to test whether actual text can return through MCP. Preparation begins immediately, without a model read being active. Does not read files, upload attachments or call a model. Call reading_probe_read with the returned relay_id; pending is not success. For pending responses retrieve the same relay within its remaining bounded read budget, without opening a blocking wait tool, another component or asking for user clicks. Only quote text from status=ready. Do not request private tools or calculate an answer yourself.', {}, () => {
    const view = app.readingRelay.create(binding);
    return {
      data: { prototype: true, relay_id: view.relay_id, expires_at: view.expires_at, model_access: 'unverified',
        next_step: 'Call reading_probe_read with this relay_id. It returns immediately so component tools can run on serialized hosts. If status=pending, allow the stated retry interval and retrieve again with the same relay_id, within pending_reads_remaining; when remaining is zero, report not ready and stop. Do not open any blocking wait tool or a new probe. The component computes and submits automatically without upload, choose or send buttons. Only status=ready includes actual text. Report a limit, expiry or other error accurately and stop.' },
      meta: { webcodexReadingRelay: view },
    };
  });
  register('reading_probe_read', 'Immediately observe an automatically prepared synthetic relay. status=ready returns actual component-submitted text; status=pending has no text and gives retry_after_ms and pending_reads_remaining. Release this tool response so component calls can run, then retrieve the same relay within the remaining budget; never hold another wait tool open or bypass the budget with new probes. Six pending observations are allowed, then RELAY_READ_LIMIT unless data is ready. Completed results remain cached until expiry. Do not calculate an answer or expose private metadata. This proves only synthetic content relay, not PDF parsing, images or native attachments.', relay,
    async (input, extra) => ({ data: await app.readingRelay.read(input.relay_id, { binding, signal: extra.signal }) }));
  register('reading_probe_poll', 'Component-only immediate command poll for the synthetic content relay. No long polling; the component must finish submission before its next poll.', privateInput,
    input => ({ data: app.readingRelay.poll(input.relay_id, input.ticket, binding) }));
  register('reading_probe_submit', 'Component-only submission for an eagerly prepared synthetic task. No model read needs to be active. Requires the view capability and exact request ID; returns acknowledgment only. Stores actual text for a later nonblocking reading_probe_read result.', {
    ...privateInput, request_id: z.string().uuid(), text: z.string().min(1).max(4096),
  }, input => ({ data: app.readingRelay.submit(input.relay_id, input.ticket, input.request_id, input.text, binding) }));
}
