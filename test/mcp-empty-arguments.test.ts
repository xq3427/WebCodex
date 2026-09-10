import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { App } from '../src/app.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { startHttp } from '../src/http.js';

type Mode = 'stdio' | 'http';
type SentCall = { tool: string; has_arguments: boolean; argument_type: string };
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function fixture(t: TestContext, enabled = false) {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-empty-args-'));
  const root = path.join(base, '合成工作区');
  const historyHome = path.join(base, 'synthetic-empty-codex');
  await mkdir(root);
  await mkdir(path.join(historyHome, 'sessions'), { recursive: true });
  await mkdir(path.join(historyHome, 'archived_sessions'));
  const configPath = path.join(base, 'config.json');
  const raw = defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic omitted-arguments device' });
  raw.codexSessions = { ...raw.codexSessions, enabled, home: historyHome };
  await writeFile(configPath, JSON.stringify(raw));
  t.after(async () => {
    const resolved = await realpath(base);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('webcodex-empty-args-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return { root, historyHome, configPath, deviceId: raw.device.id };
}

function recordOutbound(transport: Transport, sent: SentCall[]) {
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    if ('method' in message && message.method === 'tools/call') {
      // Inspect the JSON sent by the public transport. In JSON, explicit undefined is omitted.
      // This proves the SDK client did not replace a malformed or omitted value with {}.
      const wire = JSON.parse(JSON.stringify(message));
      const value = wire.params.arguments;
      sent.push({ tool: wire.params.name, has_arguments: Object.hasOwn(wire.params, 'arguments'),
        argument_type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value });
    }
    return send(message, options);
  };
}

async function connect(mode: Mode, configPath: string) {
  const client = new Client({ name: 'webcodex-empty-arguments-test', version: '1' });
  const sent: SentCall[] = [];
  if (mode === 'stdio') {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [cliPath, 'serve', '--config', configPath], stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    recordOutbound(transport, sent);
    try { await client.connect(transport); }
    catch (error) { await transport.close(); throw error; }
    return { client, sent, close: () => client.close() };
  }
  const app = new App(await loadConfig(configPath));
  const token = randomBytes(32).toString('hex');
  let listener: Awaited<ReturnType<typeof startHttp>> | undefined;
  try {
    listener = await startHttp(app, { token, port: 0 });
    const transport = new StreamableHTTPClientTransport(new URL(listener.url), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    });
    recordOutbound(transport, sent);
    await client.connect(transport);
    const owned = listener;
    return { client, sent, close: async () => {
      try { await client.close(); } finally { try { await owned.close(); } finally { await app.close(); } }
    } };
  } catch (error) { await client.close(); await listener?.close(); await app.close(); throw error; }
}

function successful(response: any) {
  assert.notEqual(response.isError, true);
  assert.equal(response.structuredContent?.ok, true);
  return response.structuredContent.data;
}
function textDiagnostic(response: any): string {
  return (response.content ?? []).filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
}
function assertOmitted(sent: SentCall[], tool: string) {
  assert.deepEqual(sent.at(-1), { tool, has_arguments: false, argument_type: 'undefined' });
}

for (const mode of ['stdio', 'http'] as const) {
  test(`${mode} permits omitted and undefined arguments for optional-only tools without client-side defaults`, async t => {
    const f = await fixture(t);
    const c = await connect(mode, f.configPath);
    try {
      // Keep the property absent in the first call, explicitly undefined in the second.
      for (const tool of ['system_status', 'workspace_list', 'workspace_health', 'file_widget_probe']) {
        for (const input of [{ name: tool }, { name: tool, arguments: undefined }]) {
          const response = await c.client.callTool(input);
          const data = successful(response);
          assertOmitted(c.sent, tool);
          assert.equal((response.structuredContent as any).source.device_id, f.deviceId);
          if (tool === 'system_status') assert.equal(data.execution_mode, 'disabled');
          if (tool === 'workspace_list' || tool === 'workspace_health') {
            assert.equal(data.workspaces.length, 1);
            assert.equal(data.workspaces[0].root, f.root);
            assert.equal(data.workspaces[0].available, true);
          }
          if (tool === 'file_widget_probe') {
            assert.equal(data.mode, 'capabilities');
            assert.equal(data.upload_performed, false);
            assert.equal(data.model_access, 'unverified');
            assert.equal(response._meta, undefined, 'A no-file probe must not issue a file ticket.');
          }
        }
      }
      assert.deepEqual(await readdir(f.root), []);
      assert.deepEqual(await readdir(path.join(f.historyHome, 'sessions')), []);
    } finally { await c.close(); }
  });

  test(`${mode} omitted codex_session_list arguments reach the disabled-access tool error`, async t => {
    const f = await fixture(t, false);
    const c = await connect(mode, f.configPath);
    try {
      for (const input of [{ name: 'codex_session_list' }, { name: 'codex_session_list', arguments: undefined }]) {
        const response: any = await c.client.callTool(input);
        assertOmitted(c.sent, 'codex_session_list');
        assert.equal(response.isError, true);
        assert.equal(response.structuredContent?.ok, false);
        assert.equal(response.structuredContent.error.code, 'CODEX_SESSIONS_DISABLED');
        assert.doesNotMatch(textDiagnostic(response), /MCP error -32602|Input validation error/);
      }
    } finally { await c.close(); }
  });

  test(`${mode} omitted codex_session_list arguments list a synthetic enabled empty history`, async t => {
    const f = await fixture(t, true);
    const c = await connect(mode, f.configPath);
    try {
      for (const input of [{ name: 'codex_session_list' }, { name: 'codex_session_list', arguments: undefined }]) {
        const response = await c.client.callTool(input);
        assertOmitted(c.sent, 'codex_session_list');
        const data = successful(response);
        assert.deepEqual(data.sessions, []);
        assert.equal(data.next_cursor, null);
      }
      assert.deepEqual(await readdir(path.join(f.historyHome, 'sessions')), []);
      assert.deepEqual(await readdir(path.join(f.historyHome, 'archived_sessions')), []);
    } finally { await c.close(); }
  });

  test(`${mode} omitted arguments never waive required fields for write or original-file tools`, async t => {
    const f = await fixture(t);
    const c = await connect(mode, f.configPath);
    try {
      for (const tool of ['fs_write', 'fs_open_file']) {
        for (const input of [{ name: tool }, { name: tool, arguments: undefined }]) {
          const response: any = await c.client.callTool(input);
          assertOmitted(c.sent, tool);
          assert.equal(response.isError, true);
          const diagnostic = textDiagnostic(response);
          assert.match(diagnostic, /MCP error -32602: Input validation error/);
          assert.ok(diagnostic.includes(tool));
          assert.match(diagnostic, /workspace_id|expected_device_id|path/);
          assert.match(diagnostic, /Required/);
          assert.notEqual(response.structuredContent?.ok, true);
          assert.equal(response._meta, undefined);
        }
      }
      assert.deepEqual(await readdir(f.root), [], 'No file may be created by an incomplete write request.');
    } finally { await c.close(); }
  });

  test(`${mode} raw null, array and string arguments reach the server unchanged and remain rejected`, async t => {
    const f = await fixture(t);
    const c = await connect(mode, f.configPath);
    try {
      for (const [argumentType, malformed] of [['null', null], ['array', []], ['string', 'not-an-object']] as const) {
        let response: any;
        let rejection: unknown;
        try {
          // Bypass callTool's convenience API; request sends this raw JSON-RPC params object.
          // Outbound observation below proves rejection is not an SDK client-side default or filter.
          response = await c.client.request({ method: 'tools/call', params: { name: 'system_status', arguments: malformed } } as any,
            CallToolResultSchema);
        } catch (error) { rejection = error; }
        assert.deepEqual(c.sent.at(-1), { tool: 'system_status', has_arguments: true, argument_type: argumentType });
        if (rejection) {
          const error = rejection as { code?: number; message?: string };
          assert.ok(error.code === -32602 || error.code === -32603, 'Server must reject the malformed arguments at protocol validation.');
          assert.match(error.message ?? '', /arguments/);
          assert.match(error.message ?? '', /object|invalid_type/i);
        } else {
          assert.equal(response?.isError, true, 'Malformed values must not be normalized to a successful empty object.');
          assert.notEqual(response?.structuredContent?.ok, true);
          assert.match(textDiagnostic(response), /arguments|object|invalid_type/i);
        }
        // A rejection must leave this same connection usable for a truly omitted argument object.
        successful(await c.client.callTool({ name: 'system_status' }));
        assertOmitted(c.sent, 'system_status');
      }
    } finally { await c.close(); }
  });
}
