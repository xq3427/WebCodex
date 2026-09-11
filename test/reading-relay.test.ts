import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { AppError } from '../src/errors.js';
import { ReadingRelayStore, type ReadingRelayCreated, type ReadingRelayOptions, type ReadingRelayResult } from '../src/reading-relay.js';

function storeFor(t: TestContext, options: ReadingRelayOptions = {}) {
  const store = new ReadingRelayStore(options);
  t.after(() => store.dispose());
  return store;
}
function textFromBrowser(created: ReadingRelayCreated): string {
  // Independent constants test the actual component contract.
  return 'WebCodex browser relay: ' + createHash('sha256').update('webcodex-reading-relay-v1:' + created.challenge, 'utf8').digest('hex');
}
function pendingId(store: ReadingRelayStore, created: ReadingRelayCreated, binding = ''): string {
  const polled = store.poll(created.relay_id, created.ticket, binding);
  assert.equal(polled.status, 'pending');
  assert.ok('request_id' in polled);
  assert.deepEqual(Object.keys(polled).sort(), ['request_id', 'status']);
  return polled.request_id;
}
function ready(result: ReadingRelayResult) {
  if (result.status !== 'ready') assert.fail('Expected actual submitted content.');
  return result;
}
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test('eager preparation can finish before any model read', async t => {
  const store = storeFor(t), created = store.create();
  assert.match(created.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(created.challenge, created.ticket);
  assert.equal(Number.isNaN(Date.parse(created.expires_at)), false);
  const requestId = pendingId(store, created), text = textFromBrowser(created);
  assert.deepEqual(store.submit(created.relay_id, created.ticket, requestId, text), { accepted: true, duplicate: false });
  assert.deepEqual(await store.read(created.relay_id), { relay_id: created.relay_id, status: 'ready', request_id: requestId, text, source: 'browser_component' });
  assert.deepEqual(store.poll(created.relay_id, created.ticket), { status: 'complete' });
});

test('fully serialized model read, component poll and submit succeeds without concurrent dispatch', { timeout: 1000 }, async t => {
  const store = storeFor(t), created = store.create();
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const next = tail.then(operation); tail = next; return next;
  };
  // The real host did not deliver component tools until the prior model read
  // returned. A blocking read deadlocks this queue until its timeout.
  const first = serialize(() => store.read(created.relay_id));
  const prepared = serialize(() => {
    const command = pendingId(store, created);
    return store.submit(created.relay_id, created.ticket, command, textFromBrowser(created));
  });
  const final = serialize(() => store.read(created.relay_id));
  assert.deepEqual(await first, { relay_id: created.relay_id, status: 'pending', retry_after_ms: 1000, pending_reads_remaining: 5 });
  assert.equal((await prepared).accepted, true);
  assert.equal(ready(await final).text, textFromBrowser(created));
});

test('pending observations disclose no content, never reset preparation and stop at six reads', async t => {
  const store = storeFor(t), created = store.create(), command = pendingId(store, created);
  for (let remaining = 5; remaining >= 0; remaining--) {
    const observed = await store.read(created.relay_id);
    assert.deepEqual(observed, { relay_id: created.relay_id, status: 'pending', retry_after_ms: 1000, pending_reads_remaining: remaining });
    for (const hidden of [command, created.ticket, created.challenge, textFromBrowser(created)]) assert.equal(JSON.stringify(observed).includes(hidden), false);
    assert.equal(pendingId(store, created), command);
  }
  await assert.rejects(store.read(created.relay_id), hasCode('RELAY_READ_LIMIT'));
  await assert.rejects(store.read(created.relay_id), hasCode('RELAY_READ_LIMIT'));
  assert.equal(pendingId(store, created), command);
  store.submit(created.relay_id, created.ticket, command, textFromBrowser(created));
  for (let retry = 0; retry < 8; retry++) assert.equal(ready(await store.read(created.relay_id)).text, textFromBrowser(created));
});

test('concurrent observations spend a finite budget without replacing the preparation', async t => {
  const store = storeFor(t, { maxPendingReads: 2 }), created = store.create(), command = pendingId(store, created);
  const results = await Promise.allSettled([store.read(created.relay_id), store.read(created.relay_id), store.read(created.relay_id)]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected']);
  if (results[0].status === 'fulfilled') assert.deepEqual(results[0].value, { relay_id: created.relay_id, status: 'pending', retry_after_ms: 1000, pending_reads_remaining: 1 });
  if (results[1].status === 'fulfilled') assert.deepEqual(results[1].value, { relay_id: created.relay_id, status: 'pending', retry_after_ms: 1000, pending_reads_remaining: 0 });
  if (results[2].status === 'rejected') assert.ok(hasCode('RELAY_READ_LIMIT')(results[2].reason));
  assert.equal(pendingId(store, created), command);
});

test('cached evidence is copied and only exact duplicate submissions are idempotent', async t => {
  const store = storeFor(t), created = store.create(), command = pendingId(store, created), text = textFromBrowser(created);
  store.submit(created.relay_id, created.ticket, command, text);
  const original = ready(await store.read(created.relay_id)); original.text = 'caller mutation';
  assert.equal(ready(await store.read(created.relay_id)).text, text);
  assert.deepEqual(store.submit(created.relay_id, created.ticket, command, text), { accepted: true, duplicate: true });
  assert.throws(() => store.submit(created.relay_id, created.ticket, command, 'conflict'), hasCode('RELAY_STALE_SUBMISSION'));
  assert.throws(() => store.submit(created.relay_id, created.ticket, 'different-request', text), hasCode('RELAY_STALE_SUBMISSION'));
  assert.equal(ready(await store.read(created.relay_id)).request_id, command);
});

test('relay isolates tickets, bindings, instances and prepared request identities', async t => {
  const store = storeFor(t), otherStore = storeFor(t), first = store.create('host-a'), second = store.create('host-b');
  const command = pendingId(store, first, 'host-a');
  await assert.rejects(store.read(first.relay_id, { binding: 'host-b' }), hasCode('RELAY_NOT_FOUND'));
  await assert.rejects(otherStore.read(first.relay_id, { binding: 'host-a' }), hasCode('RELAY_NOT_FOUND'));
  for (const ticket of [second.ticket, '', first.ticket.slice(1), first.ticket + 'a']) assert.throws(() => store.poll(first.relay_id, ticket, 'host-a'), hasCode('RELAY_ACCESS_DENIED'));
  assert.throws(() => store.poll(first.relay_id, first.ticket, 'host-b'), hasCode('RELAY_ACCESS_DENIED'));
  assert.throws(() => store.submit(second.relay_id, second.ticket, command, textFromBrowser(first), 'host-b'), hasCode('RELAY_STALE_SUBMISSION'));
  assert.throws(() => store.submit(first.relay_id, first.ticket, 'unissued-request', textFromBrowser(first), 'host-a'), hasCode('RELAY_STALE_SUBMISSION'));
  store.submit(first.relay_id, first.ticket, command, textFromBrowser(first), 'host-a');
  assert.equal(ready(await store.read(first.relay_id, { binding: 'host-a' })).text, textFromBrowser(first));
});

test('invalid content and excess UTF-8 payloads cannot produce ready evidence', async t => {
  const store = storeFor(t, { maxTextBytes: 128 }), created = store.create(), command = pendingId(store, created);
  for (const payload of ['', 'arbitrary content', textFromBrowser(store.create())]) assert.throws(() => store.submit(created.relay_id, created.ticket, command, payload), hasCode('RELAY_INVALID_CONTENT'));
  for (const payload of ['x'.repeat(129), '文'.repeat(43)]) assert.throws(() => store.submit(created.relay_id, created.ticket, command, payload), hasCode('RELAY_PAYLOAD_TOO_LARGE'));
  assert.equal(pendingId(store, created), command);
  assert.equal((await store.read(created.relay_id)).status, 'pending');
  store.submit(created.relay_id, created.ticket, command, textFromBrowser(created));
  assert.equal((await store.read(created.relay_id)).status, 'ready');
});

test('cancelled reads neither spend observations nor cancel independent preparation', async t => {
  const store = storeFor(t, { maxPendingReads: 1 }), created = store.create(), command = pendingId(store, created);
  const controller = new AbortController(); controller.abort('private host cancellation detail');
  await assert.rejects(store.read(created.relay_id, { signal: controller.signal }), error => {
    assert.ok(hasCode('RELAY_CANCELLED')(error)); assert.equal(String(error).includes('private host'), false); return true;
  });
  assert.deepEqual(await store.read(created.relay_id), { relay_id: created.relay_id, status: 'pending', retry_after_ms: 1000, pending_reads_remaining: 0 });
  assert.equal(pendingId(store, created), command);
  store.submit(created.relay_id, created.ticket, command, textFromBrowser(created));
  await assert.rejects(store.read(created.relay_id, { signal: controller.signal }), hasCode('RELAY_CANCELLED'));
  assert.equal(ready(await store.read(created.relay_id)).text, textFromBrowser(created));
});

test('aborting after an immediate read does not revoke the component request', async t => {
  const store = storeFor(t), created = store.create(), command = pendingId(store, created), controller = new AbortController();
  const observed = await store.read(created.relay_id, { signal: controller.signal }); controller.abort();
  assert.equal(observed.status, 'pending'); assert.equal(pendingId(store, created), command);
  store.submit(created.relay_id, created.ticket, command, textFromBrowser(created));
  assert.equal((await store.read(created.relay_id)).status, 'ready');
});

test('automatic expiry reclaims eager jobs without a model read or explicit close', async t => {
  const store = storeFor(t, { ttlMs: 15, maxSessions: 1 }), created = store.create(), command = pendingId(store, created);
  await delay(40);
  await assert.rejects(store.read(created.relay_id), hasCode('RELAY_NOT_FOUND'));
  assert.throws(() => store.submit(created.relay_id, created.ticket, command, textFromBrowser(created)), hasCode('RELAY_ACCESS_DENIED'));
  assert.ok(store.create().relay_id);
});

test('observations do not extend expiry and expired handles cannot return cached evidence', async t => {
  let now = 0;
  const store = storeFor(t, { ttlMs: 1000, now: () => now }), prepared = store.create();
  now = 900; assert.equal((await store.read(prepared.relay_id)).status, 'pending');
  now = 1000; await assert.rejects(store.read(prepared.relay_id), hasCode('RELAY_EXPIRED'));
  const completed = store.create(); store.submit(completed.relay_id, completed.ticket, pendingId(store, completed), textFromBrowser(completed));
  now = 2000; await assert.rejects(store.read(completed.relay_id), hasCode('RELAY_EXPIRED'));
});

test('capacity is reclaimed by expiry and close while old work stays invalid', async t => {
  let now = 0;
  const store = storeFor(t, { maxSessions: 1, ttlMs: 1000, now: () => now }), original = store.create();
  assert.throws(() => store.create(), hasCode('RELAY_CAPACITY'));
  now = 1000; const replacement = store.create(); assert.notEqual(replacement.relay_id, original.relay_id);
  const command = pendingId(store, replacement); store.close(replacement.relay_id, replacement.ticket);
  assert.ok(store.create().relay_id);
  assert.throws(() => store.submit(replacement.relay_id, replacement.ticket, command, textFromBrowser(replacement)), hasCode('RELAY_ACCESS_DENIED'));
});

test('dispose invalidates prepared and completed jobs and is idempotent', async t => {
  const store = storeFor(t), first = store.create(), second = store.create();
  store.submit(second.relay_id, second.ticket, pendingId(store, second), textFromBrowser(second));
  store.dispose(); store.dispose();
  assert.throws(() => store.create(), hasCode('RELAY_CLOSED'));
  await assert.rejects(store.read(first.relay_id), hasCode('RELAY_CLOSED'));
  await assert.rejects(store.read(second.relay_id), hasCode('RELAY_CLOSED'));
  assert.throws(() => store.poll(first.relay_id, first.ticket), hasCode('RELAY_CLOSED'));
});

test('relay limits and bindings reject unbounded inputs', t => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000]) {
    for (const field of ['ttlMs', 'maxSessions', 'maxTextBytes', 'maxPendingReads']) assert.throws(() => new ReadingRelayStore({ [field]: value }), hasCode('RELAY_INVALID_ARGUMENT'));
  }
  assert.throws(() => new ReadingRelayStore({ maxPendingReads: 7 }), hasCode('RELAY_INVALID_ARGUMENT'));
  const store = storeFor(t); assert.throws(() => store.create('x'.repeat(257)), hasCode('RELAY_INVALID_ARGUMENT'));
});
