import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, readFile, unlink, link, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { App } from '../src/app.js';
import { defaultConfig } from '../src/config.js';
import { FileWidgetDeliveryService } from '../src/file-widget-delivery.js';
import type { AppConfig } from '../src/types.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type DeliveryLimits = { fileWidgetTicketTtlMs?: number; fileWidgetCacheMaxBytes?: number; fileWidgetChunkMaxBytes?: number };

async function fixture(t: TestContext, limits: DeliveryLimits = {}) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-widget-delivery-'));
  const root = path.join(base, 'workspace'), other = path.join(base, 'other');
  await Promise.all([mkdir(root), mkdir(other)]);
  const configPath = path.join(base, 'config.json');
  const config: AppConfig = { ...defaultConfig(root, configPath), version: 2, configPath,
    device: { id: randomUUID(), name: 'Synthetic delivery device' },
    workspaces: [root, other].map((directory, index) => ({ id: index ? 'other' : 'default', uid: randomUUID(), root: directory, name: path.basename(directory), readOnly: false })) };
  Object.assign(config.limits, limits);
  let now = 1900000000000, app = new App(config), delivery = new FileWidgetDeliveryService(app, { now: () => now });
  const original = async (name: string, bytes: Buffer, workspaceId = 'default') => {
    await writeFile(path.join(workspaceId === 'default' ? root : other, name), bytes);
    return app.fileTransfers.read({ workspace_id: workspaceId, path: name });
  };
  t.after(async () => {
    delivery.close(); await app.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-widget-delivery-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { base, root, other, config, original, advance: (ms: number) => { now += ms; }, get now() { return now; },
    get app() { return app; }, get delivery() { return delivery; },
    restart: async () => { delivery.close(); await app.close(); app = new App(config); delivery = new FileWidgetDeliveryService(app, { now: () => now }); } };
}

test('file tickets prepare metadata only and reconstruct an immutable raw file with stable retries and per-chunk hashes', async t => {
  const f = await fixture(t, { fileWidgetChunkMaxBytes: 4096 });
  const bytes = randomBytes(10017), name = '原件 +#25% 😀.bin', original = await f.original(name, bytes);
  const ticket = await f.delivery.prepare(original);
  assert.match(ticket.ticket_id, /^[A-Za-z0-9_-]{43}$/); assert.equal(Buffer.from(ticket.ticket_id, 'base64url').length, 32);
  assert.equal(ticket.expires_at, new Date(f.now + 300000).toISOString()); assert.equal(ticket.chunk_max_bytes, 4096);
  assert.deepEqual(Object.keys(ticket).sort(), ['chunk_max_bytes', 'expires_at', 'ticket_id']);
  assert.equal(JSON.stringify(ticket).includes(bytes.toString('base64')), false);
  assert.ok(Buffer.byteLength(JSON.stringify(ticket)) < 256);
  assert.deepEqual(f.delivery.stats(), { closed: false, ticket_count: 1, cached_bytes: bytes.length });
  const chunks: Buffer[] = []; let offset: number | null = 0;
  while (offset !== null) {
    const input: { ticket_id: string; expected_device_id: string; offset: number } = { ticket_id: ticket.ticket_id, expected_device_id: f.app.identity.deviceId, offset };
    const result = await f.delivery.read(input), decoded = Buffer.from(result.base64, 'base64');
    assert.deepEqual(await f.delivery.read(input), result, 'Same-offset retries must return the same immutable bytes.');
    assert.equal(result.data.offset, offset); assert.equal(result.data.sha256, sha(bytes)); assert.equal(result.data.chunk_sha256, sha(decoded));
    assert.equal(result.data.total_bytes, bytes.length); assert.equal(result.data.size_bytes, decoded.length); assert.ok(decoded.length <= 4096);
    assert.equal(result.data.eof, offset + decoded.length === bytes.length);
    assert.equal(JSON.stringify(result.data).includes(result.base64), false);
    chunks.push(decoded); offset = result.data.next_offset;
  }
  assert.deepEqual(Buffer.concat(chunks), bytes); assert.deepEqual(await readFile(path.join(f.root, name)), bytes);
  const end = await f.delivery.read({ ticket_id: ticket.ticket_id, expected_device_id: f.app.identity.deviceId, offset: bytes.length });
  assert.equal(end.base64, ''); assert.equal(end.data.eof, true); assert.equal(end.data.next_offset, null); assert.equal(end.data.chunk_sha256, sha(Buffer.alloc(0)));
  const audits = JSON.stringify(f.app.store.db.prepare('SELECT event,details FROM audit_events').all());
  assert.equal(audits.includes(ticket.ticket_id), false); assert.equal(audits.includes(bytes.toString('base64')), false);
});

test('snapshots survive source edits and final-file deletion while new paths and linked replacements are rechecked', async t => {
  const f = await fixture(t), bytes = Buffer.from('Original complete bytes'), original = await f.original('sample.bin', bytes);
  const ticket = await f.delivery.prepare(original), input = { ticket_id: ticket.ticket_id, expected_device_id: f.app.identity.deviceId, offset: 0 };
  await writeFile(path.join(f.root, 'sample.bin'), 'A later file version');
  assert.deepEqual(Buffer.from((await f.delivery.read(input)).base64, 'base64'), bytes);
  await unlink(path.join(f.root, 'sample.bin'));
  assert.deepEqual(Buffer.from((await f.delivery.read(input)).base64, 'base64'), bytes);
  await writeFile(path.join(f.other, 'outside.bin'), bytes);
  await link(path.join(f.other, 'outside.bin'), path.join(f.root, 'sample.bin'));
  await assert.rejects(f.delivery.read(input), { code: 'PATH_DENIED' });
  await assert.rejects(f.delivery.release(input), { code: 'PATH_DENIED' });
  await unlink(path.join(f.root, 'sample.bin'));
  assert.deepEqual(await f.delivery.release(input), { released: true });
  assert.equal(f.delivery.stats().cached_bytes, 0);
});

test('expiry, release and restart revoke tickets without timers or persisted ticket identifiers', async t => {
  const f = await fixture(t, { fileWidgetTicketTtlMs: 1000 });
  const original = await f.original('expiry.bin', Buffer.from('snapshot'));
  const ticket = await f.delivery.prepare(original), input = { ticket_id: ticket.ticket_id, expected_device_id: f.app.identity.deviceId, offset: 0 };
  f.advance(999); assert.equal((await f.delivery.read(input)).data.eof, true);
  f.advance(1); await assert.rejects(f.delivery.read(input), { code: 'FILE_WIDGET_TICKET_EXPIRED' });
  assert.deepEqual(f.delivery.stats(), { closed: false, ticket_count: 0, cached_bytes: 0 });
  const released = await f.delivery.prepare(original);
  await f.delivery.release({ ticket_id: released.ticket_id, expected_device_id: input.expected_device_id });
  await assert.rejects(f.delivery.read({ ...input, ticket_id: released.ticket_id }), { code: 'FILE_WIDGET_TICKET_NOT_FOUND' });
  const pending = await f.delivery.prepare(original);
  await f.restart();
  await assert.rejects(f.delivery.read({ ...input, ticket_id: pending.ticket_id }), { code: 'FILE_WIDGET_TICKET_NOT_FOUND' });
  assert.deepEqual(f.delivery.stats(), { closed: false, ticket_count: 0, cached_bytes: 0 });
});

test('raw cache capacity reserves concurrent prepares, never evicts active tickets and recovers on release or expiry', async t => {
  const f = await fixture(t, { fileWidgetCacheMaxBytes: 8, fileWidgetTicketTtlMs: 1000 });
  const a = await f.original('a.bin', Buffer.from('AAAAAA')), b = await f.original('b.bin', Buffer.from('BBBBBB'));
  const results = await Promise.allSettled([f.delivery.prepare(a), f.delivery.prepare(b)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failure.reason.code, 'FILE_WIDGET_CACHE_FULL');
  const first = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<FileWidgetDeliveryService['prepare']>>>).value;
  assert.deepEqual(f.delivery.stats(), { closed: false, ticket_count: 1, cached_bytes: 6 });
  assert.equal((await f.delivery.read({ ticket_id: first.ticket_id, expected_device_id: f.app.identity.deviceId, offset: 0 })).data.total_bytes, 6);
  await f.delivery.release({ ticket_id: first.ticket_id, expected_device_id: f.app.identity.deviceId });
  await f.delivery.prepare(b); f.advance(1000);
  const afterExpiry = await f.delivery.prepare(a);
  assert.equal(f.delivery.stats().ticket_count, 1); assert.equal(f.delivery.stats().cached_bytes, 6);
  assert.equal((await f.delivery.read({ ticket_id: afterExpiry.ticket_id, expected_device_id: f.app.identity.deviceId, offset: 0 })).base64, Buffer.from('AAAAAA').toString('base64'));
});

test('at most 32 tickets can be cached even when every original file is empty', async t => {
  const f = await fixture(t, { fileWidgetCacheMaxBytes: 1 }), original = await f.original('empty.bin', Buffer.alloc(0));
  const tickets = [];
  for (let index = 0; index < 32; index++) tickets.push(await f.delivery.prepare(original));
  assert.equal(new Set(tickets.map(ticket => ticket.ticket_id)).size, 32);
  assert.deepEqual(f.delivery.stats(), { closed: false, ticket_count: 32, cached_bytes: 0 });
  await assert.rejects(f.delivery.prepare(original), { code: 'FILE_WIDGET_CACHE_FULL' });
  const result = await f.delivery.read({ ticket_id: tickets[0].ticket_id, expected_device_id: f.app.identity.deviceId, offset: 0 });
  assert.equal(result.base64, ''); assert.equal(result.data.size_bytes, 0); assert.equal(result.data.eof, true);
  await f.delivery.release({ ticket_id: tickets[0].ticket_id, expected_device_id: f.app.identity.deviceId });
  await f.delivery.prepare(original); assert.equal(f.delivery.stats().ticket_count, 32);
});

test('device, workspace policy and binding changes reject ticket reads and releases before returning bytes', async t => {
  const f = await fixture(t), original = await f.original('bound.bin', Buffer.from('bound snapshot'));
  const ticket = await f.delivery.prepare(original), input = { ticket_id: ticket.ticket_id, expected_device_id: f.app.identity.deviceId, offset: 0 };
  await assert.rejects(f.delivery.read({ ...input, expected_device_id: randomUUID() }), { code: 'DEVICE_MISMATCH' });
  await assert.rejects(f.delivery.release({ ...input, expected_device_id: randomUUID() }), { code: 'DEVICE_MISMATCH' });
  f.config.workspaces[0].readOnly = true;
  assert.equal((await f.delivery.read(input)).data.eof, true, 'Read-only workspaces may deliver already authorized originals.');
  f.config.workspaces[0].enabled = false;
  await assert.rejects(f.delivery.read(input), { code: 'WORKSPACE_DISABLED' });
  await assert.rejects(f.delivery.release(input), { code: 'WORKSPACE_DISABLED' });
  f.config.workspaces[0].enabled = true;
  const uid = f.config.workspaces[0].uid; f.config.workspaces[0].uid = randomUUID();
  await assert.rejects(f.delivery.read(input), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  f.config.workspaces[0].uid = uid;
  const deviceId = f.config.device!.id; f.config.device!.id = randomUUID();
  await assert.rejects(f.delivery.read(input), { code: 'STATE_DEVICE_MISMATCH' });
  f.config.device!.id = deviceId;
  f.config.workspaces[0].root = f.other;
  await assert.rejects(f.delivery.read(input), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  f.config.workspaces[0].root = f.root;
  await f.delivery.release(input); assert.equal(f.delivery.stats().ticket_count, 0);
});

test('an unavailable or replaced physical workspace root cannot reuse a captured ticket', async t => {
  const f = await fixture(t), ticket = await f.delivery.prepare(await f.original('offline.bin', Buffer.from('old root')));
  const input = { ticket_id: ticket.ticket_id, expected_device_id: f.app.identity.deviceId, offset: 0 }, saved = path.join(f.base, 'saved-root');
  for (const target of [f.root, saved]) { const relative = path.relative(f.base, target); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); }
  assert.equal(await realpath(f.root), f.root);
  await rename(f.root, saved);
  await assert.rejects(f.delivery.read(input), { code: 'WORKSPACE_UNAVAILABLE' });
  await assert.rejects(f.delivery.release(input), { code: 'WORKSPACE_UNAVAILABLE' });
  await mkdir(f.root); await writeFile(path.join(f.root, 'offline.bin'), 'replacement root');
  await assert.rejects(f.delivery.read(input), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
});

test('invalid offsets and ticket identifiers fail without evicting valid cached snapshots', async t => {
  const f = await fixture(t), ticket = await f.delivery.prepare(await f.original('offset.bin', Buffer.alloc(10, 0xa7)));
  const input = { ticket_id: ticket.ticket_id, expected_device_id: f.app.identity.deviceId, offset: 0 };
  for (const offset of [-1, 1.5, 11, NaN, Infinity]) await assert.rejects(f.delivery.read({ ...input, offset }), { code: 'INVALID_ARGUMENT' });
  for (const id of ['', '../state', 'x'.repeat(44), ' '.repeat(43)]) await assert.rejects(f.delivery.read({ ...input, ticket_id: id }), { code: 'FILE_WIDGET_TICKET_INVALID' });
  await assert.rejects(f.delivery.read({ ...input, ticket_id: randomBytes(32).toString('base64url') }), { code: 'FILE_WIDGET_TICKET_NOT_FOUND' });
  assert.equal(f.delivery.stats().ticket_count, 1); assert.equal((await f.delivery.read(input)).data.size_bytes, 10);
});

test('prepare rejects invalid or mismatched snapshot bytes, ownership and configuration before storing a ticket', async t => {
  const f = await fixture(t), original = await f.original('validated.bin', Buffer.from('source original'));
  const other = await f.original('validated.bin', Buffer.from('other original'), 'other');
  const changedBinding = structuredClone(other);
  changedBinding.data.workspace_id = 'default';
  await assert.rejects(f.delivery.prepare(changedBinding), { code: 'INVALID_FILE_SNAPSHOT' });
  const corrupt = structuredClone(original);
  assert.equal(corrupt.content[0].type, 'resource');
  if (corrupt.content[0].type === 'resource' && 'blob' in corrupt.content[0].resource) corrupt.content[0].resource.blob = Buffer.from('wrong! original').toString('base64');
  await assert.rejects(f.delivery.prepare(corrupt), { code: 'INVALID_FILE_SNAPSHOT' });
  const malformed = structuredClone(original);
  if (malformed.content[0].type === 'resource' && 'blob' in malformed.content[0].resource) malformed.content[0].resource.blob += '\n';
  await assert.rejects(f.delivery.prepare(malformed), { code: 'INVALID_FILE_SNAPSHOT' });
  assert.equal(f.delivery.stats().ticket_count, 0);
  const limits = f.config.limits as typeof f.config.limits & DeliveryLimits;
  for (const [field, value] of [['fileWidgetTicketTtlMs', 999], ['fileWidgetTicketTtlMs', 1800001], ['fileWidgetCacheMaxBytes', 0], ['fileWidgetCacheMaxBytes', 268435457], ['fileWidgetChunkMaxBytes', 4095], ['fileWidgetChunkMaxBytes', 262145]] as const) {
    limits[field] = value;
    await assert.rejects(f.delivery.prepare(original), { code: 'CONFIG_ERROR' });
    delete limits[field];
  }
  f.config.limits.fileWidgetUploadMaxBytes = 1;
  await assert.rejects(f.delivery.prepare(original), { code: 'FILE_TOO_LARGE' });
  assert.equal(f.delivery.stats().cached_bytes, 0);
});

test('release or close during path authorization prevents a pending read from returning a stale chunk', async t => {
  const f = await fixture(t), original = await f.original('pending.bin', Buffer.from('pending bytes'));
  const ticket = await f.delivery.prepare(original), input = { ticket_id: ticket.ticket_id, expected_device_id: f.app.identity.deviceId, offset: 0 };
  const resolve = f.app.ctx.paths.resolve.bind(f.app.ctx.paths);
  let pauseNext = true, resume!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.app.ctx.paths.resolve = async (...args) => {
    const result = await resolve(...args);
    if (pauseNext) { pauseNext = false; entered(); await paused; }
    return result;
  };
  const pending = f.delivery.read(input); await started;
  await f.delivery.release(input); resume();
  await assert.rejects(pending, { code: 'FILE_WIDGET_TICKET_NOT_FOUND' });
  f.app.ctx.paths.resolve = resolve;
  const another = await f.delivery.prepare(original);
  f.app.ctx.paths.resolve = async (...args) => { const result = await resolve(...args); f.delivery.close(); return result; };
  await assert.rejects(f.delivery.read({ ...input, ticket_id: another.ticket_id }), { code: 'SERVICE_CLOSING' });
  f.app.ctx.paths.resolve = resolve;
  f.delivery.close(); f.delivery.close();
  assert.deepEqual(f.delivery.stats(), { closed: true, ticket_count: 0, cached_bytes: 0 });
  await assert.rejects(f.delivery.read({ ...input, ticket_id: another.ticket_id }), { code: 'SERVICE_CLOSING' });
  await assert.rejects(f.delivery.release({ ticket_id: another.ticket_id, expected_device_id: input.expected_device_id }), { code: 'SERVICE_CLOSING' });
  await assert.rejects(f.delivery.prepare(original), { code: 'SERVICE_CLOSING' });
});
