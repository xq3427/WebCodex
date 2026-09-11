import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { App } from '../src/app.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { FILE_WIDGET_URI, FILE_WIDGET_MIME_TYPE, LEGACY_FILE_WIDGET_URIS } from '../src/file-widget.js';
import { startHttp } from '../src/http.js';
import { VERSION } from '../src/version.js';
import { READING_RELAY_URI } from '../src/reading-relay-widget.js';
import { LEGACY_READING_RELAY_URIS } from '../src/reading-relay-probe.js';
import { DOCUMENT_WIDGET_URI, LEGACY_DOCUMENT_WIDGET_URIS } from '../src/document-widget.js';
import { FILE_SAVE_WIDGET_URI } from '../src/file-save-widget.js';

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-resource-compat-'));
  const root = path.join(base, 'project');
  await mkdir(root);
  const configPath = path.join(base, 'config.json');
  const raw = defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic resource compatibility' });
  await writeFile(configPath, JSON.stringify(raw));
  const sourcePath = path.join(root, 'synthetic.bin');
  await writeFile(sourcePath, Buffer.from([0, 7, 255, 42]));
  t.after(async () => {
    const resolved = await realpath(base);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('webcodex-resource-compat-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return { configPath, sourcePath };
}

async function connect(mode: 'stdio' | 'http', configPath: string) {
  const client = new Client({ name: 'file-resource-compatibility-test', version: '1' });
  if (mode === 'stdio') {
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [cli, 'serve', '--config', configPath], stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    try { await client.connect(transport); }
    catch (error) { await transport.close(); throw error; }
    return { client, close: () => client.close() };
  }
  const app = new App(await loadConfig(configPath));
  const token = randomBytes(32).toString('hex');
  let listener: Awaited<ReturnType<typeof startHttp>> | undefined;
  try {
    listener = await startHttp(app, { token, port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(listener.url), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }));
    const owned = listener;
    return { client, close: async () => {
      try { await client.close(); } finally { try { await owned.close(); } finally { await app.close(); } }
    } };
  } catch (error) { await client.close(); await listener?.close(); await app.close(); throw error; }
}

for (const mode of ['stdio', 'http'] as const) {
  test(`${mode} serves the current component for finite legacy URIs without exposing file resources`, async t => {
    const f = await fixture(t);
    const c = await connect(mode, f.configPath);
    try {
      assert.equal(c.client.getServerVersion()?.version, VERSION);
      assert.equal(FILE_WIDGET_URI, `ui://webcodex/file-feasibility-${encodeURIComponent(VERSION)}.html`);
      const expectedLegacy = ['ui://webcodex/file-feasibility-v012.html',
        ...Array.from({ length: 8 }, (_, index) => `ui://webcodex/file-feasibility-v012-preview${index + 1}.html`),
        'ui://webcodex/file-feasibility-0.12.0-preview.9.html',
        'ui://webcodex/file-feasibility-0.12.0-preview.10.html',
        'ui://webcodex/file-feasibility-0.12.0-preview.11.html',
        'ui://webcodex/file-feasibility-0.13.0-preview.1.html',
        'ui://webcodex/file-feasibility-0.13.0-preview.2.html',
        'ui://webcodex/file-feasibility-0.14.0-preview.1.html',
        'ui://webcodex/file-feasibility-0.14.0-preview.2.html',
        'ui://webcodex/file-feasibility-0.14.0-preview.3.html',
        'ui://webcodex/file-feasibility-0.14.0-preview.4.html',
        'ui://webcodex/file-feasibility-0.15.0-preview.1.html',
        'ui://webcodex/file-feasibility-0.15.0-preview.2.html',
        'ui://webcodex/file-feasibility-0.15.0-preview.3.html',
        'ui://webcodex/file-feasibility-0.15.0-preview.4.html',
        'ui://webcodex/file-feasibility-0.15.0-preview.5.html',
        'ui://webcodex/file-feasibility-0.15.0-preview.6.html', 'ui://webcodex/file-feasibility-0.15.0-preview.7.html', 'ui://webcodex/file-feasibility-0.16.0-preview.1.html', 'ui://webcodex/file-feasibility-0.16.0-preview.2.html', 'ui://webcodex/file-feasibility-0.16.0-preview.3.html', 'ui://webcodex/file-feasibility-0.16.0-preview.4.html', 'ui://webcodex/file-feasibility-0.16.0-preview.5.html', 'ui://webcodex/file-feasibility-0.16.0-preview.6.html'];
      assert.deepEqual([...LEGACY_FILE_WIDGET_URIS], expectedLegacy);
      const allowed = [...new Set([FILE_WIDGET_URI, ...expectedLegacy])];
      const listed = await c.client.listResources();
      assert.deepEqual(listed.resources.map(item => item.uri).sort(), [...allowed, READING_RELAY_URI, ...LEGACY_READING_RELAY_URIS, DOCUMENT_WIDGET_URI, ...LEGACY_DOCUMENT_WIDGET_URIS, FILE_SAVE_WIDGET_URI].sort());
      assert.equal((await c.client.listResourceTemplates()).resourceTemplates.length, 0, 'Compatibility must not introduce a wildcard resource template.');

      const tools = await c.client.listTools();
      assert.equal(tools.tools.length, 65);
      for (const name of ['fs_open_file', 'file_widget_probe']) {
        const metadata = tools.tools.find(tool => tool.name === name)!._meta as any;
        assert.equal(metadata.ui.resourceUri, FILE_WIDGET_URI);
        assert.equal(metadata['openai/outputTemplate'], FILE_WIDGET_URI);
      }
      let currentHtml: string | undefined;
      for (const uri of allowed) {
        const result = await c.client.readResource({ uri });
        assert.equal(result.contents.length, 1);
        const resource = result.contents[0];
        assert.equal(resource.uri, uri, 'Ordinary alias requests retain their requested URI in contents.');
        assert.equal(resource.mimeType, FILE_WIDGET_MIME_TYPE);
        assert.ok('text' in resource);
        const html = resource.text;
        const versionLiteral = html.match(/const BUILD_VERSION = ("(?:[^"\\]|\\.)*");/);
        assert.ok(versionLiteral, 'Resource must contain a JSON-encoded component build version.');
        assert.equal(JSON.parse(versionLiteral[1]), VERSION);
        assert.ok(html.includes("write('version', BUILD_VERSION)"));
        assert.ok(html.includes('version: BUILD_VERSION'));
        if (currentHtml === undefined) currentHtml = html;
        else assert.equal(html, currentHtml, 'Every legacy URI serves the same current static component.');
      }

      const original: any = await c.client.callTool({ name: 'fs_read_file', arguments: {
        workspace_id: 'default', path: 'synthetic.bin',
      } });
      assert.equal(original.structuredContent.ok, true);
      const snapshotUri = original.structuredContent.data.snapshot_uri;
      assert.match(snapshotUri, /^webcodex-file:/);
      const unknown = [
        'ui://webcodex/file-feasibility-v012-preview999.html',
        'ui://webcodex/unregistered.html',
        'ui://webcodex/folder/../synthetic.bin',
        `${FILE_WIDGET_URI}?cache=old`, `${FILE_WIDGET_URI}#component`,
        `${expectedLegacy[0]}?cache=old`, `${expectedLegacy[0]}#component`,
        pathToFileURL(f.sourcePath).href, snapshotUri,
      ];
      for (const uri of unknown) await assert.rejects(c.client.readResource({ uri }), { code: -32602 });

      // Keep SDK URL semantics: normalizing to a registered URI can only return that static HTML.
      const normalizedAlias = `ui://webcodex/unused/../${new URL(FILE_WIDGET_URI).pathname.slice(1)}`;
      assert.equal(new URL(normalizedAlias).toString(), FILE_WIDGET_URI);
      const normalized = await c.client.readResource({ uri: normalizedAlias });
      assert.equal(normalized.contents[0].uri, FILE_WIDGET_URI);
      assert.ok('text' in normalized.contents[0]);
      assert.equal(normalized.contents[0].text, currentHtml);
      const afterErrors = await c.client.readResource({ uri: FILE_WIDGET_URI });
      assert.ok('text' in afterErrors.contents[0]);
      assert.equal(afterErrors.contents[0].text, currentHtml, 'Rejected resource requests must not corrupt the active component.');
    } finally { await c.close(); }
  });
}
