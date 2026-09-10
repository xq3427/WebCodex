import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { App } from '../src/app.js';
import { defaultConfig } from '../src/config.js';
import { FileTransferService } from '../src/file-transfer.js';
import type { AppConfig } from '../src/types.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Transfer = Awaited<ReturnType<FileTransferService['read']>>;

async function fixture(t: TestContext) {
  const parent = await fs.realpath(tmpdir());
  const base = await fs.mkdtemp(path.join(parent, 'webcodex-transfer-'));
  const root = path.join(base, '项目 A'), other = path.join(base, '项目 B');
  await Promise.all([fs.mkdir(root), fs.mkdir(other)]);
  const configPath = path.join(base, 'config.json');
  const config: AppConfig = { ...defaultConfig(root, configPath), version: 2, configPath,
    device: { id: randomUUID(), name: 'Synthetic file transfer device' },
    workspaces: [root, other].map((directory, index) => ({ id: index ? 'other' : 'default', uid: randomUUID(), name: path.basename(directory), root: directory, readOnly: index === 1 })) };
  let app: App | undefined, transfer: FileTransferService | undefined;
  const start = () => { assert.equal(app, undefined); app = new App(config); transfer = new FileTransferService(app.ctx); return transfer; };
  const move = async (from: string, to: string) => {
    for (const target of [from, to]) {
      const relative = path.relative(base, path.resolve(target));
      assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    }
    assert.equal(await fs.realpath(from), path.resolve(from));
    await fs.rename(from, to);
  };
  t.after(async () => {
    await app?.close();
    const actual = await fs.realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-transfer-'));
    await fs.rm(actual, { recursive: true, force: true });
  });
  return { base, root, other, config, start, move, get app() { assert.ok(app); return app; }, get transfer() { assert.ok(transfer); return transfer; } };
}

function originalBytes(result: Transfer): Buffer {
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  if (block.type === 'image') return Buffer.from(block.data, 'base64');
  assert.equal(block.type, 'resource');
  assert.ok(block.type === 'resource' && 'blob' in block.resource);
  return Buffer.from(block.resource.blob, 'base64');
}

test('whole-file transfer preserves arbitrary binary, empty files, BOMs and invalid text encodings exactly', async t => {
  const f = await fixture(t); f.start();
  const inputs = [
    Buffer.from(Array.from({ length: 256 }, (_, index) => index)), Buffer.alloc(0),
    Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from('中文😀\r\nlast\n')]),
    Buffer.concat([Buffer.from([255, 254]), Buffer.from('中文😀\r\n', 'utf16le')]),
    Buffer.concat([Buffer.from([254, 255]), Buffer.from('中文😀\r\n', 'utf16le').swap16()]),
    Buffer.from([255, 254, 0, 216, 255]), Buffer.from([255, 192, 128, 0, 13, 10]),
    Buffer.from('Authorization: Bearer SYNTHETIC-RAW-FILE-CONTENT\r\n'),
  ];
  for (const [index, bytes] of inputs.entries()) {
    const name = `原文 ${index}.txt`;
    await fs.writeFile(path.join(f.root, name), bytes);
    const result = await f.transfer.read({ workspace_id: 'default', path: name });
    assert.deepEqual(originalBytes(result), bytes);
    assert.equal(result.data.size_bytes, bytes.length);
    assert.equal(result.data.sha256, sha(bytes));
    assert.equal(result.data.complete, true);
    assert.equal(result.data.transfer_encoding, 'base64');
    assert.equal(result.data.content_kind, 'resource');
    assert.equal(result.data.mime_type_source, 'extension');
    assert.equal(result.data.content_validated, false);
    assert.equal(result.data.content_processing, 'none');
    assert.equal(result.data.content_processing_scope, 'server_only');
    assert.equal(result.data.model_access, 'unverified');
    assert.equal(result.data.display_name, name);
    assert.equal(result.data.client_attachment_support, 'unverified');
    assert.equal('blob' in result.data, false);
    assert.equal('content' in result.data, false);
    assert.ok(CallToolResultSchema.safeParse({ content: result.content }).success);
  }
  const records = f.app.store.db.prepare("SELECT details FROM audit_events WHERE event='fs_read_file'").all();
  assert.equal(records.length, inputs.length);
  for (const row of records) assert.deepEqual(Object.keys(JSON.parse(row.details as string)).sort(), ['content_kind', 'mime_type', 'path', 'sha256', 'size_bytes']);
  assert.equal(JSON.stringify(records).includes('SYNTHETIC-RAW-FILE-CONTENT'), false);
});

test('image headers select native MCP image blocks without reencoding original bytes', async t => {
  const f = await fixture(t); f.start();
  const images = [
    ['image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=', 'base64')],
    ['image/gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')],
    // Header fixtures deliberately make no assertion that the entire image is valid or decoded.
    ['image/jpeg', Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 217])],
    ['image/webp', Buffer.from('5249464616000000574542505650384c090000002f000000000710fd8f00', 'hex')],
  ] as const;
  for (const [index, [mime, bytes]] of images.entries()) {
    const name = `signature-${index}.bin`;
    await fs.writeFile(path.join(f.root, name), bytes);
    const result = await f.transfer.read({ workspace_id: 'default', path: name });
    assert.equal(result.data.content_kind, 'image');
    assert.equal(result.data.mime_type, mime);
    assert.equal(result.data.mime_type_source, 'signature');
    assert.equal(result.data.content_validated, false);
    assert.equal(result.data.content_processing_scope, 'server_only');
    assert.equal(result.data.model_access, 'unverified');
    assert.equal(result.data.display_name, name);
    assert.equal(result.data.next_step, undefined, 'Native image content remains directly usable when exposed by the host.');
    assert.deepEqual(originalBytes(result), bytes);
    assert.equal(result.data.sha256, sha(bytes));
    assert.ok(CallToolResultSchema.safeParse({ content: result.content }).success);
  }
});

test('extensions provide document MIME hints but unsupported or false image headers remain resource blobs', async t => {
  const f = await fixture(t); f.start();
  const samples = [
    ['paper.PDF', 'application/pdf'],
    ['paper.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['old.doc', 'application/msword'], ['old.xls', 'application/vnd.ms-excel'], ['old.ppt', 'application/vnd.ms-powerpoint'],
    ['data.zip', 'application/zip'], ['data.csv', 'text/csv'], ['data.tsv', 'text/tab-separated-values'],
    ['data.json', 'application/json'], ['fake.png', 'image/png'], ['fake.jpg', 'image/jpeg'],
    ['fake.gif', 'image/gif'], ['fake.webp', 'image/webp'], ['vector.svg', 'image/svg+xml'],
    ['data.unknown', 'application/octet-stream'],
  ];
  const bytes = Buffer.from([0, 255, 1, 2, 3]);
  for (const [name, mime] of samples) {
    await fs.writeFile(path.join(f.root, name), bytes);
    const result = await f.transfer.read({ workspace_id: 'default', path: name });
    assert.equal(result.data.mime_type, mime);
    assert.equal(result.data.mime_type_source, name.endsWith('.unknown') ? 'default' : 'extension');
    assert.equal(result.data.content_kind, 'resource');
    assert.deepEqual(originalBytes(result), bytes);
  }
});

test('embedded snapshot URIs identify service, workspace and exact content without a public or local file URL', async t => {
  const f = await fixture(t); f.start();
  const name = '论文 +#25% 😀.pdf', bytes = Buffer.from('%PDF-SYNTHETIC\x00\xff', 'latin1');
  await Promise.all([fs.writeFile(path.join(f.root, name), bytes), fs.writeFile(path.join(f.other, name), bytes)]);
  const first = await f.transfer.read({ workspace_id: 'default', path: name });
  const repeat = await f.transfer.read({ workspace_id: 'default', path: name });
  const other = await f.transfer.read({ workspace_id: 'other', path: name });
  const another = await new FileTransferService(f.app.ctx).read({ workspace_id: 'default', path: name });
  assert.equal(first.data.snapshot_uri, repeat.data.snapshot_uri);
  assert.notEqual(first.data.snapshot_uri, other.data.snapshot_uri);
  assert.notEqual(first.data.snapshot_uri, another.data.snapshot_uri);
  const uri = new URL(first.data.snapshot_uri);
  assert.equal(uri.protocol, 'webcodex-file:');
  assert.equal(uri.pathname.split('/')[1], f.app.identity.workspaceIdentity('default'));
  assert.equal(uri.pathname.split('/')[2], sha(bytes));
  assert.equal(decodeURIComponent(uri.pathname.split('/')[3]), name);
  assert.equal(first.data.uri_scope, 'embedded_snapshot_only');
  assert.equal(first.data.path, name);
  assert.equal(first.data.name, name);
  assert.equal(first.data.display_name, name, 'The display label preserves the original Unicode filename independently of URI escaping.');
  assert.equal(uri.pathname.split('/')[3], encodeURIComponent(name));
  assert.equal(uri.search, ''); assert.equal(uri.hash, '');
  assert.notEqual(uri.pathname.split('/')[3], first.data.display_name);
  assert.deepEqual(first.data.next_step?.arguments, { workspace_id: 'default', path: name, expected_device_id: f.app.identity.deviceId });
  assert.equal(first.data.next_step?.tool, 'fs_open_file');
  assert.match(first.data.next_step!.when, /ChatGPT native attachments/);
  assert.match(first.data.next_step!.when, /Only if the user explicitly asks.*experimental route/);
  assert.match(first.data.next_step!.when, /current-conversation attachment and actual file access/);
  assert.match(first.data.model_usage, /human-readable file label/);
  assert.match(first.data.model_usage, /not a download link or a resources\/read endpoint/);
  assert.match(first.data.model_usage, /does not mean the host cannot parse or preview/);
  assert.match(first.data.model_usage, /do not claim to have read/i);
  assert.match(first.data.model_usage, /Do not automatically substitute text extraction, OCR, rendering/);
  assert.equal(JSON.stringify(first.data).includes(f.base), false);
  assert.equal(first.content[0].type, 'resource');
  if (first.content[0].type === 'resource') {
    assert.equal(first.content[0].resource.uri, first.data.snapshot_uri);
    assert.deepEqual(Object.keys(first.content[0].resource).sort(), ['blob', 'mimeType', 'uri'], 'Display instructions must not invent protocol fields inside embedded resources.');
  }
  assert.deepEqual(originalBytes(other), bytes, 'Read-only workspaces can transfer their authorized files.');
});

test('SVG, WAV, MP4 and archives preserve their original bytes as resource blobs with an explicit host-dependent next step', async t => {
  const f = await fixture(t); f.start();
  // The small SVG, PCM WAV and empty ZIP are self-contained. The MP4 container
  // header tests transport routing only; this test makes no playback claim.
  const svg = Buffer.from('\ufeff<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2">\r\n  <rect width="2" height="2" fill="#123abc"/>\r\n</svg>\r\n');
  const wav = Buffer.alloc(48);
  wav.write('RIFF', 0); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
  wav.writeInt16LE(-1234, 44); wav.writeInt16LE(5678, 46);
  const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32000000086d646174', 'hex');
  const archive = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  const samples = [
    ['矢量 +#25% 😀.svg', svg, 'image/svg+xml'],
    ['录音 +#25% 😀.wav', wav, 'audio/wav'],
    ['视频 +#25% 😀.mp4', mp4, 'video/mp4'],
    ['归档 +#25% 😀.zip', archive, 'application/zip'],
  ] as const;
  for (const [name, bytes, mime] of samples) {
    await fs.writeFile(path.join(f.root, name), bytes);
    const result = await f.transfer.read({ workspace_id: 'default', path: name });
    assert.equal(result.content.length, 1); assert.equal(result.content[0].type, 'resource');
    assert.equal(result.data.content_kind, 'resource'); assert.equal(result.data.mime_type, mime); assert.equal(result.data.mime_type_source, 'extension');
    assert.equal(result.data.display_name, name); assert.equal(result.data.content_processing, 'none'); assert.equal(result.data.content_processing_scope, 'server_only');
    assert.equal(result.data.content_validated, false); assert.equal(result.data.model_access, 'unverified'); assert.equal(result.data.client_attachment_support, 'unverified');
    assert.equal(result.data.next_step?.tool, 'fs_open_file');
    assert.deepEqual(result.data.next_step?.arguments, { workspace_id: 'default', path: name, expected_device_id: f.app.identity.deviceId });
    assert.deepEqual(originalBytes(result), bytes); assert.equal(result.data.sha256, sha(bytes)); assert.equal(result.data.size_bytes, bytes.length);
    assert.deepEqual(await fs.readFile(path.join(f.root, name)), bytes);
    const encoded = bytes.toString('base64');
    assert.equal(JSON.stringify(result).split(encoded).length - 1, 1, 'The encoded original is emitted once, never repeated in model metadata.');
    assert.equal(JSON.stringify(result.data).includes(encoded), false);
    assert.ok(CallToolResultSchema.safeParse({ content: result.content }).success);
  }
});

test('transfer limit rejects the entire oversized file before reading and remains independent of text and write limits', async t => {
  const f = await fixture(t);
  f.config.limits.fileTransferMaxBytes = 1024;
  f.config.limits.readMaxBytes = 256;
  f.config.limits.fileReadMaxBytes = 256;
  f.config.limits.writeMaxBytes = 256;
  f.start();
  const bytes = Buffer.alloc(1024, 255);
  await fs.writeFile(path.join(f.root, 'exact.bin'), bytes);
  assert.deepEqual(originalBytes(await f.transfer.read({ workspace_id: 'default', path: 'exact.bin' })), bytes);
  const tooLarge = path.join(f.root, 'large.bin');
  await fs.writeFile(tooLarge, Buffer.alloc(1025, 254));
  const original = fs.open;
  let opened = false;
  const mocked = t.mock.method(fs, 'open', async (...args: any[]) => {
    if (String(args[0]) === tooLarge) opened = true;
    return Reflect.apply(original, fs, args);
  });
  try {
    await assert.rejects(f.transfer.read({ workspace_id: 'default', path: 'large.bin' }), { code: 'FILE_TOO_LARGE' });
    assert.equal(opened, false);
    assert.equal(f.app.store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event='fs_read_file'").get()!.n, 1);
  } finally { mocked.mock.restore(); }
  for (const invalid of [0, -1, 1.5, NaN, Infinity, 7 * 1024 * 1024 + 1]) {
    f.config.limits.fileTransferMaxBytes = invalid;
    await assert.rejects(f.transfer.read({ workspace_id: 'default', path: 'exact.bin' }), { code: 'CONFIG_ERROR' });
  }
});

test('whole-file transfer rejects directories, traversal, protected files and hard links', async t => {
  const f = await fixture(t); f.start();
  await fs.mkdir(path.join(f.root, 'folder'));
  await fs.writeFile(path.join(f.root, 'a.bin'), Buffer.from([255, 0]));
  await fs.link(path.join(f.root, 'a.bin'), path.join(f.root, 'linked.bin'));
  for (const file of ['../outside.bin', f.root, '.env', '.codex/auth.json', '.webcodex/config.json', '.git/config', 'API_key.txt', 'linked.bin', 'a.bin']) {
    await assert.rejects(f.transfer.read({ workspace_id: 'default', path: file }), { code: 'PATH_DENIED' });
  }
  await assert.rejects(f.transfer.read({ workspace_id: 'default', path: 'folder' }), { code: 'NOT_A_FILE' });
  await assert.rejects(f.transfer.read({ workspace_id: 'unknown', path: 'file.bin' }), { code: 'WORKSPACE_NOT_FOUND' });
});

test('disabled and skipped workspaces cannot transfer bytes while an available workspace remains independent', async t => {
  const f = await fixture(t);
  f.config.workspaces[0].enabled = false;
  await fs.writeFile(path.join(f.other, 'a.bin'), Buffer.from([255, 0, 1]));
  f.start();
  await assert.rejects(f.transfer.read({ workspace_id: 'default', path: 'a.bin' }), { code: 'WORKSPACE_DISABLED' });
  assert.equal((await f.transfer.read({ workspace_id: 'other', path: 'a.bin' })).data.complete, true);

  const offline = await fixture(t);
  offline.config.workspaces[0].onUnavailable = 'skip';
  await offline.move(offline.root, path.join(offline.base, 'original'));
  offline.start();
  await assert.rejects(offline.transfer.read({ workspace_id: 'default', path: 'a.bin' }), { code: 'WORKSPACE_UNAVAILABLE' });
  await fs.mkdir(offline.root);
  await fs.writeFile(path.join(offline.root, 'a.bin'), Buffer.from([255, 0]));
  await assert.rejects(offline.transfer.read({ workspace_id: 'default', path: 'a.bin' }), { code: 'WORKSPACE_RESTART_REQUIRED' });
});

test('a bound root going offline or being replaced cannot transfer another directory under its old identity', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'a.bin'), Buffer.from([1, 2, 3]));
  f.start();
  await f.move(f.root, path.join(f.base, 'original'));
  await assert.rejects(f.transfer.read({ workspace_id: 'default', path: 'a.bin' }), { code: 'WORKSPACE_UNAVAILABLE' });
  await fs.mkdir(f.root);
  await fs.writeFile(path.join(f.root, 'a.bin'), Buffer.from([4, 5, 6]));
  await assert.rejects(f.transfer.read({ workspace_id: 'default', path: 'a.bin' }), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
});

test('root replacement after path authorization is rejected before returning replacement bytes', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'a.bin'), Buffer.from([1, 2, 3]));
  f.start();
  const resolve = f.app.ctx.paths.resolve.bind(f.app.ctx.paths);
  let replaced = false;
  f.app.ctx.paths.resolve = async (...args) => {
    const result = await resolve(...args);
    if (!replaced) {
      replaced = true;
      await f.move(f.root, path.join(f.base, 'original'));
      await fs.mkdir(f.root);
      await fs.writeFile(path.join(f.root, 'a.bin'), Buffer.from([4, 5, 6]));
    }
    return result;
  };
  try {
    await assert.rejects(f.transfer.read({ workspace_id: 'default', path: 'a.bin' }), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
    assert.equal(replaced, true);
  } finally { f.app.ctx.paths.resolve = resolve; }
});

test('file replacement between lstat and open is rejected even when the size and bytes match', async t => {
  const f = await fixture(t); f.start();
  const file = path.join(f.root, 'a.bin'), bytes = Buffer.alloc(128, 255);
  await fs.writeFile(file, bytes);
  const original = fs.open;
  let replaced = false;
  const mocked = t.mock.method(fs, 'open', async (...args: any[]) => {
    if (!replaced && String(args[0]) === file) {
      replaced = true;
      await f.move(file, path.join(f.root, 'original.bin'));
      await fs.writeFile(file, bytes);
    }
    return Reflect.apply(original, fs, args);
  });
  try {
    await assert.rejects(f.transfer.read({ workspace_id: 'default', path: 'a.bin' }), { code: 'FILE_CHANGED' });
    assert.equal(replaced, true);
  } finally { mocked.mock.restore(); }
});

test('same-size mutation while reading does not return mixed original and new bytes', async t => {
  const f = await fixture(t); f.start();
  const file = path.join(f.root, 'a.bin'), bytes = Buffer.alloc(65536 + 128, 255);
  await fs.writeFile(file, bytes);
  const original = fs.open;
  let mutated = false;
  const mocked = t.mock.method(fs, 'open', async (...args: any[]) => {
    const handle = await Reflect.apply(original, fs, args);
    if (String(args[0]) === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs: any[]) => {
        const result = await Reflect.apply(read, handle, readArgs);
        if (!mutated) { mutated = true; await fs.writeFile(file, Buffer.alloc(bytes.length, 254)); }
        return result;
      };
    }
    return handle;
  });
  try {
    await assert.rejects(f.transfer.read({ workspace_id: 'default', path: 'a.bin' }), { code: 'FILE_CHANGED' });
    assert.equal(mutated, true);
    assert.equal(f.app.store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event='fs_read_file'").get()!.n, 0);
  } finally { mocked.mock.restore(); }
});

test('post-read identity validation rejects a workspace registration changed before delivery', async t => {
  const f = await fixture(t); f.start();
  await fs.writeFile(path.join(f.root, 'a.bin'), Buffer.from([1, 2, 3]));
  const resolve = f.app.ctx.paths.resolve.bind(f.app.ctx.paths);
  let checks = 0;
  f.app.ctx.paths.resolve = async (...args) => {
    const result = await resolve(...args);
    if (++checks === 2) f.config.workspaces[0].uid = randomUUID();
    return result;
  };
  try {
    await assert.rejects(f.transfer.read({ workspace_id: 'default', path: 'a.bin' }), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
    assert.equal(checks, 2);
  } finally { f.app.ctx.paths.resolve = resolve; }
});
