import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '../src/app.js';
import { createMcpServer } from '../src/server.js';
import { defaultUnifiedConfig, validateConfig } from '../src/config.js';
import { hash } from '../src/filesystem.js';

// A complete, uncompressed OPC package is generated in source for portable CI.
// It needs no Office installation, Python, ZIP package or binary repository fixture.
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const ns = `xmlns:a="${A}" xmlns:p="${P}" xmlns:r="${R}"`;
const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const rels = (items: [string, string, string][]) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const crc32 = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
};
function zip(parts: Record<string, string>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, xml] of Object.entries(parts)) {
    const filename = Buffer.from(name), data = Buffer.from(xml), crc = crc32(data), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); header.copy(directory, 6, 4, 30); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, data); central.push(directory, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function presentation(phrase: string) {
  const types: Record<string, string> = { 'ppt/presentation.xml': 'presentation.main', 'ppt/slides/slide1.xml': 'slide', 'ppt/slideLayouts/slideLayout1.xml': 'slideLayout', 'ppt/slideMasters/slideMaster1.xml': 'slideMaster' };
  return zip({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(types).map(([name, type]) => `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`).join('')}</Types>`,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `<p:presentation ${ns}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="master"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['slide', 'slide', 'slides/slide1.xml'], ['master', 'slideMaster', 'slideMasters/slideMaster1.xml']]),
    'ppt/slides/slide1.xml': `<p:sld ${ns}><p:cSld><p:spTree>${group}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Acceptance title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="10363200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="3200"/><a:t>${phrase}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': rels([['layout', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${ns} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['master', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${ns}><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="layout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['layout', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
  });
}
function slideXml(bytes: Buffer): string {
  for (let offset = 0; bytes.readUInt32LE(offset) === 0x04034b50;) {
    const size = bytes.readUInt32LE(offset + 18), names = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + names + extra, data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), bytes.readUInt32LE(offset + 14));
    if (bytes.subarray(offset + 30, offset + 30 + names).toString() === 'ppt/slides/slide1.xml') return data.toString();
    offset = start + size;
  }
  throw new Error('The PPTX package has no slide');
}

test('valid PPTX crosses real downloader and MCP import, survives stat/overwrite/restore, and keeps source credentials out of state', async t => {
  const phrase = 'WebCodex PPTX 原字节验收 548217', bytes = presentation(phrase), replacement = presentation('WebCodex 第二版 693025');
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-pptx-import-')), root = path.join(base, '论文');
  await mkdir(root); const configPath = path.join(base, 'config.json'), config = await validateConfig(defaultUnifiedConfig(root, configPath), configPath);
  const app = new App(config), server = createMcpServer(app), client = new Client({ name: 'pptx-local-acceptance', version: '1' });
  t.after(async () => { await client.close(); await server.close(); await app.close(); const actual = await realpath(base); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-pptx-import-')); await rm(actual, { recursive: true, force: true }); });
  let downloads = 0;
  t.mock.method(dns, 'lookup', async () => [{ address: '104.18.12.32', family: 4 }]);
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: (response: unknown) => void) => {
    assert.equal(url.hostname, 'files.oaiusercontent.com'); assert.equal(options.rejectUnauthorized, true); assert.ok(options.lookup);
    const data = downloads++ === 0 ? bytes : replacement;
    const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-length': String(data.length) }, complete: true });
    const request = Object.assign(new EventEmitter(), { destroy: () => response.destroy(), end: () => { callback(response); response.write(data.subarray(0, 257)); response.end(data.subarray(257)); } });
    return request;
  });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const file = { download_url: 'https://files.oaiusercontent.com/synthetic.pptx?sig=PRIVATE-PPTX-URL', file_id: 'file-PRIVATE-PPTX-ID', file_name: '模型生成.pptx', mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  const request = { workspace_id: 'default', expected_device_id: app.identity.deviceId, path: '论文重点预览.pptx', file, expected_sha256: null, idempotency_key: 'first-import' };
  const call = async (name: string, args: Record<string, unknown>) => { const result = await client.callTool({ name, arguments: args }) as any; assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(result.structuredContent.ok, true); return result.structuredContent.data; };
  const saved = await call('fs_import_file', request), destination = path.join(root, request.path);
  assert.equal(saved.verified, true); assert.equal(saved.sha256, hash(bytes)); assert.equal(saved.size_bytes, bytes.length);
  const local = await readFile(destination); assert.deepEqual(local, bytes); assert.ok(slideXml(local).includes(`<a:t>${phrase}</a:t>`));
  assert.deepEqual(await call('fs_import_file', request), saved); assert.equal(downloads, 1);
  const stat = await call('fs_stat', { workspace_id: 'default', path: request.path }); assert.equal(stat.sha256, hash(bytes)); assert.equal(stat.size_bytes, bytes.length);
  const overwritten = await call('fs_import_file', { ...request, expected_sha256: stat.sha256, idempotency_key: 'second-import' });
  assert.deepEqual(await readFile(destination), replacement); assert.equal(downloads, 2);
  await call('changes_restore', { workspace_id: 'default', expected_device_id: app.identity.deviceId, change_id: overwritten.change_id, expected_sha256: overwritten.sha256, idempotency_key: 'restore-first' });
  assert.deepEqual(await readFile(destination), bytes); assert.equal((await call('fs_stat', { workspace_id: 'default', path: request.path })).sha256, hash(bytes));
  const persisted = JSON.stringify({ saved, operations: app.store.db.prepare('SELECT * FROM operations').all(), audit: app.store.db.prepare('SELECT * FROM audit_events').all() });
  for (const secret of ['PRIVATE-PPTX-URL', file.download_url, file.file_id]) assert.equal(persisted.includes(secret), false);
  // Opt-in local evidence copy; CI needs neither this directory nor a Python runtime.
  if (process.env.WEBCODEX_KEEP_PPTX_ACCEPTANCE === '1') { await mkdir('.webcodex', { recursive: true }); await writeFile('.webcodex/generated-pptx-local-acceptance.pptx', await readFile(destination)); }
});
