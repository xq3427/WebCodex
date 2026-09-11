import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '../src/app.js';
import { createMcpServer } from '../src/server.js';
import { defaultUnifiedConfig, validateConfig } from '../src/config.js';
import { hash } from '../src/filesystem.js';

// Generate a complete stored OPC package in source, without Office or a ZIP
// dependency. Its size matches the reported PPTX, but every byte is synthetic.
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const ns = `xmlns:a="${A}" xmlns:p="${P}" xmlns:r="${R}"`;
const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const rels = (items: [string, string, string][]) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(parts: Record<string, string>) {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, xml] of Object.entries(parts)) {
    const filename = Buffer.from(name), data = Buffer.from(xml), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); header.copy(directory, 6, 4, 30); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, data); central.push(directory, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function presentation(phrase: string, sizeBytes: number) {
  const types: Record<string, string> = { 'ppt/presentation.xml': 'presentation.main', 'ppt/slides/slide1.xml': 'slide', 'ppt/slideLayouts/slideLayout1.xml': 'slideLayout', 'ppt/slideMasters/slideMaster1.xml': 'slideMaster' };
  const custom = (padding: string) => `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="WebCodexSyntheticTransportData"><vt:lpwstr>${padding}</vt:lpwstr></property></Properties>`;
  const parts: Record<string, string> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(types).map(([name, type]) => `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`).join('')}<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>`,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml'], ['rId2', 'custom-properties', 'docProps/custom.xml']]),
    'ppt/presentation.xml': `<p:presentation ${ns}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="master"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['slide', 'slide', 'slides/slide1.xml'], ['master', 'slideMaster', 'slideMasters/slideMaster1.xml']]),
    'ppt/slides/slide1.xml': `<p:sld ${ns}><p:cSld><p:spTree>${group}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Acceptance title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="10363200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="3200"/><a:t>${phrase}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': rels([['layout', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${ns} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['master', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${ns}><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="layout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['layout', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'docProps/custom.xml': custom(''),
  };
  const paddingSize = sizeBytes - zip(parts).length;
  assert.ok(paddingSize > 0);
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let seed = 19, padding = '';
  for (let i = 0; i < paddingSize; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; padding += alphabet[seed % alphabet.length]; }
  parts['docProps/custom.xml'] = custom(padding);
  const bytes = zip(parts); assert.equal(bytes.length, sizeBytes);
  return bytes;
}
function inspectStoredZip(bytes: Buffer) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10), centralStart = bytes.readUInt32LE(end + 16);
  assert.equal(centralStart + bytes.readUInt32LE(end + 12), end);
  const entries = new Map<string, Buffer>(); let offset = centralStart;
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    assert.equal(bytes.readUInt16LE(offset + 10), 0);
    const size = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    assert.equal(bytes.readUInt32LE(offset + 20), size);
    const local = bytes.readUInt32LE(offset + 42), name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString();
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt32LE(local + 22), size);
    const localNameLength = bytes.readUInt16LE(local + 26), start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    assert.equal(bytes.subarray(local + 30, local + 30 + localNameLength).toString(), name);
    const data = bytes.subarray(start, start + size);
    assert.equal(data.length, size); assert.equal(crc32(data), bytes.readUInt32LE(offset + 16)); assert.equal(crc32(data), bytes.readUInt32LE(local + 14));
    assert.ok(!entries.has(name)); entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, end);
  return entries;
}
async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-pptx-chunks-')), root = path.join(base, '论文');
  await mkdir(root); const configPath = path.join(base, 'config.json');
  // Retain the original 14-chunk recovery fixture under an explicit legacy setting.
  const config = await validateConfig({ ...defaultUnifiedConfig(root, configPath), binaryInputs: { chunkMaxBytes: 12288 } }, configPath);
  const app = new App(config), server = createMcpServer(app), client = new Client({ name: 'pptx-chunk-acceptance', version: '1' });
  t.after(async () => { await client.close(); await server.close(); await app.close(); const actual = await realpath(base); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-pptx-chunks-')); await rm(actual, { recursive: true, force: true }); });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const raw = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as any;
  const call = async (name: string, args: Record<string, unknown>) => { const result = await raw(name, args); assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(result.structuredContent.ok, true); return result.structuredContent.data; };
  return { app, root, client, call, raw };
}

test('170732-byte synthetic PPTX crosses bounded MCP chunks and commits exact, valid OPC bytes once', async t => {
  const f = await fixture(t), phrase = 'WebCodex 分块原字节验收 PRIVATE-SYNTHETIC-714209', bytes = presentation(phrase, 170732);
  const originalEntries = inspectStoredZip(bytes), digest = hash(bytes), chunkSize = 12288;
  assert.equal(originalEntries.size, 11); assert.equal(bytes.toString('base64').length, 227644);
  for (const module of [http, https]) t.mock.method(module, 'request', () => { assert.fail('Chunk transfer must not download a file'); });
  t.mock.method(childProcess, 'spawn', () => { assert.fail('Chunk transfer must not run a local command'); });
  const base = { workspace_id: 'default', path: 'IE-Attack 合成原文件-🙂.pptx', expected_device_id: f.app.identity.deviceId, content_sha256: digest, size_bytes: bytes.length, expected_sha256: null, idempotency_key: 'pptx-chunk-save' };
  const destination = path.join(f.root, base.path), statusArgs = { workspace_id: base.workspace_id, expected_device_id: base.expected_device_id, idempotency_key: base.idempotency_key };
  let last: Record<string, unknown> = {}, saved: any;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    const request = { ...base, offset_bytes: offset, content_base64: chunk.toString('base64'), chunk_sha256: hash(chunk) };
    const result = await f.call('fs_write_binary_chunk', request);
    assert.equal(result.next_offset, offset + chunk.length);
    if (offset + chunk.length < bytes.length) {
      assert.equal(result.status, 'receiving'); assert.equal(result.received_bytes, offset + chunk.length); assert.equal(result.total_bytes, bytes.length);
      await assert.rejects(readFile(destination), { code: 'ENOENT' });
      if (offset === 0) {
        const duplicate = await f.call('fs_write_binary_chunk', request);
        assert.equal(duplicate.status, 'receiving'); assert.equal(duplicate.next_offset, chunk.length);
        const progress = await f.call('fs_write_binary_status', statusArgs);
        assert.equal(progress.received_bytes, chunk.length);
        const diagnostic = JSON.stringify(progress);
        assert.ok(!diagnostic.includes(request.content_base64)); assert.ok(!diagnostic.includes(phrase));
      }
    } else { assert.equal(result.status, 'saved'); saved = result; last = request; }
  }
  assert.equal(saved.verified, true); assert.equal(saved.sha256, digest); assert.equal(saved.size_bytes, bytes.length);
  const local = await readFile(destination); assert.deepEqual(local, bytes);
  const localEntries = inspectStoredZip(local); assert.deepEqual(localEntries, originalEntries);
  assert.ok(localEntries.get('ppt/slides/slide1.xml')!.toString().includes(`<a:t>${phrase}</a:t>`));
  assert.match(localEntries.get('_rels/.rels')!.toString(), /custom-properties/);
  if (process.env.WEBCODEX_KEEP_PPTX_ACCEPTANCE === '1') {
    await mkdir('.webcodex', { recursive: true });
    await writeFile('.webcodex/generated-pptx-chunks-local-acceptance.pptx', local);
  }
  const stat = await f.call('fs_stat', { workspace_id: base.workspace_id, path: base.path });
  assert.equal(stat.sha256, digest); assert.equal(stat.size_bytes, bytes.length);
  const operation = await f.call('operation_status', { ...statusArgs, tool: 'fs_write_binary' });
  assert.equal(operation.stage, 'done'); assert.equal(operation.receipt.sha256, digest); assert.equal(operation.current_observation.sha256, digest);
  assert.deepEqual(f.app.store.db.prepare('SELECT tool FROM file_operations').all().map(row => row.tool), ['fs_write_binary']);
  assert.equal((await f.app.files.changesList({ workspace_id: base.workspace_id })).changes.length, 1);
  const completion = await f.call('fs_write_binary_status', statusArgs);
  const diagnostic = JSON.stringify({ completion, operation, journal: f.app.store.db.prepare('SELECT * FROM file_operations').all(), audit: f.app.store.db.prepare('SELECT * FROM audit_events').all() });
  for (const privateContent of [phrase, bytes.toString('base64'), String(last.content_base64)]) assert.ok(!diagnostic.includes(privateContent));
  const external = Buffer.from('Subsequent external edit must survive duplicate final delivery.');
  await writeFile(destination, external);
  const duplicate = await f.call('fs_write_binary_chunk', last);
  assert.equal(duplicate.status, 'saved'); assert.equal(duplicate.sha256, digest);
  assert.deepEqual(await readFile(destination), external);
  assert.equal((await f.app.files.changesList({ workspace_id: base.workspace_id })).changes.length, 1);
  assert.equal(f.app.config.execution.mode, 'disabled');
});

test('MCP chunk device and read-only policy changes prevent final PPTX commit', async t => {
  const f = await fixture(t), bytes = presentation('WebCodex 权限验收', 170732), chunkSize = 12288;
  const base = { workspace_id: 'default', path: '权限变更.pptx', expected_device_id: f.app.identity.deviceId, content_sha256: hash(bytes), size_bytes: bytes.length, expected_sha256: null, idempotency_key: 'pptx-policy' };
  const make = (offset: number) => { const chunk = bytes.subarray(offset, offset + chunkSize); return { ...base, offset_bytes: offset, content_base64: chunk.toString('base64'), chunk_sha256: hash(chunk) }; };
  const wrongDevice = await f.raw('fs_write_binary_chunk', { ...make(0), expected_device_id: randomUUID() });
  assert.equal(wrongDevice.structuredContent.error.code, 'DEVICE_MISMATCH');
  let offset = 0;
  while (offset + chunkSize < bytes.length) { await f.call('fs_write_binary_chunk', make(offset)); offset += chunkSize; }
  f.app.config.workspaces[0].readOnly = true;
  const denied = await f.raw('fs_write_binary_chunk', make(offset));
  assert.equal(denied.structuredContent.error.code, 'READ_ONLY');
  await assert.rejects(readFile(path.join(f.root, base.path)), { code: 'ENOENT' });
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM file_operations').get()!.n, 0);
});
