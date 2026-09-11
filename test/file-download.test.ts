import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { AppError, errorResult } from '../src/errors.js';
import { downloadChatGptFile } from '../src/file-download.js';

const SOURCE = 'https://files.oaiusercontent.com/generated-file?sig=SYNTHETIC-SECRET';
const PUBLIC_V4 = { address: '104.18.12.32', family: 4 };
const PUBLIC_V6 = { address: '2606:4700::6812:c20', family: 6 };
type Reply = {
  status?: number; headers?: Record<string, string>; chunks?: Buffer[];
  waitMs?: number; incomplete?: boolean; stall?: boolean;
  requestError?: boolean; responseError?: boolean;
};

function harness(t: TestContext, replies: Reply[] = [{}], addresses = [PUBLIC_V4]) {
  const requests: { url: URL; options: https.RequestOptions; pinned?: unknown[]; destroyed: boolean }[] = [];
  const lookups: string[] = [];
  t.mock.method(dns, 'lookup', async (hostname: string) => { lookups.push(hostname); return addresses; });
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: (response: unknown) => void) => {
    const index = requests.length;
    const record = { url, options, pinned: undefined as unknown[] | undefined, destroyed: false };
    requests.push(record);
    assert.equal(url.hostname, 'files.oaiusercontent.com');
    assert.equal(options.agent, false);
    assert.deepEqual(options.headers, { 'Accept-Encoding': 'identity' });
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.checkServerIdentity, undefined);
    assert.ok(options.lookup);
    options.lookup(url.hostname, {}, ((...args: unknown[]) => { record.pinned = args; }) as never);
    const reply = replies[index];
    assert.ok(reply, 'unexpected extra request');
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string>; complete: boolean };
    response.statusCode = reply.status ?? 200;
    response.headers = reply.headers ?? {};
    response.complete = !reply.incomplete;
    request.destroy = () => { record.destroyed = true; response.destroy(); };
    const abort = () => request.emit('error', new Error('Native error containing ' + SOURCE));
    options.signal?.addEventListener('abort', abort, { once: true });
    response.once('close', () => options.signal?.removeEventListener('abort', abort));
    request.end = () => {
      void (async () => {
        if (reply.waitMs) await delay(reply.waitMs);
        if (record.destroyed) return;
        if (reply.requestError) { request.emit('error', new Error('Secret request error ' + SOURCE)); return; }
        callback(response);
        if (reply.responseError) { response.destroy(new Error('Secret response error ' + SOURCE)); return; }
        if (reply.stall || response.destroyed) return;
        for (const chunk of reply.chunks ?? []) if (!response.destroyed) response.write(chunk);
        if (!response.destroyed) response.end();
      })();
    };
    return request;
  });
  return { requests, lookups };
}

async function rejectsSafe(run: Promise<unknown>, code: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.equal((error as Error & { cause?: unknown }).cause, undefined);
    assert.equal(JSON.stringify(error).includes('SYNTHETIC-SECRET'), false);
    assert.equal(error.message.includes('https://'), false);
    return true;
  });
}

async function rejectsSource(run: Promise<unknown>, stage: string, reason: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'FILE_IMPORT_SOURCE_DENIED');
    assert.deepEqual(error.details, { stage, reason });
    const result = errorResult(error);
    assert.equal(result.error.retryable, false);
    const encoded = JSON.stringify(result);
    for (const secret of ['SYNTHETIC-SECRET', '/mnt/data/', 'private-rejected.example', '104.18.12.32', '127.0.0.1', '198.18.0.7']) {
      assert.equal(encoded.includes(secret), false);
    }
    return true;
  });
}

test('source URL denials identify sandbox references and fixed policy reasons without exposing original inputs', async t => {
  const h = harness(t);
  for (const [url, reason] of [
    ['sandbox:/mnt/data/SYNTHETIC-SECRET.pptx', 'sandbox_reference'],
    ['E:\\中文 目录\\SYNTHETIC-SECRET.pdf', 'local_file_reference'],
    ['file:///C:/SYNTHETIC-SECRET.pdf', 'local_file_reference'],
    ['/home/example/SYNTHETIC-SECRET.pdf', 'local_file_reference'],
    ['not-a-SYNTHETIC-SECRET-url', 'invalid_url'],
    ['http://files.oaiusercontent.com/SYNTHETIC-SECRET', 'https_required'],
    ['https://private-rejected.example/SYNTHETIC-SECRET', 'host_not_allowed'],
    [SOURCE + '#SYNTHETIC-SECRET', 'url_policy_violation'],
    ['https://name:SYNTHETIC-SECRET@files.oaiusercontent.com/file', 'url_policy_violation'],
    ['https://files.oaiusercontent.com:8443/SYNTHETIC-SECRET', 'url_policy_violation'],
  ]) await rejectsSource(downloadChatGptFile(url, { maxBytes: 10 }), 'source_url', reason);
  assert.equal(h.requests.length, 0); assert.equal(h.lookups.length, 0);
});

test('a local file passed to the importer returns a local-copy recovery without exposing the path', async t => {
  const h=harness(t);
  await assert.rejects(downloadChatGptFile('E:\\SYNTHETIC-SECRET\\paper.pdf',{maxBytes:10}),error=>{
    const failure=errorResult(error);
    assert.equal(failure.error.code,'FILE_IMPORT_SOURCE_DENIED');
    assert.deepEqual(failure.error.details,{stage:'source_url',reason:'local_file_reference'});
    assert.equal(failure.error.recovery.action,'copy_local_source');
    assert.ok(failure.error.recovery.tools.includes('fs_copy'));
    assert.ok(!JSON.stringify(failure).includes('SYNTHETIC-SECRET'));
    return true;
  });
  assert.equal(h.requests.length,0);assert.equal(h.lookups.length,0);
});

test('DNS denials distinguish empty, invalid and non-public answers without exposing addresses', async t => {
  const h = harness(t);
  const cases = [
    { addresses: [], reason: 'empty_answer' },
    { addresses: [{ address: PUBLIC_V4.address, family: 6 }], reason: 'invalid_address' },
    { addresses: [PUBLIC_V4, { address: '127.0.0.1', family: 4 }], reason: 'non_public_address' },
    { addresses: [{ address: '198.18.0.7', family: 4 }], reason: 'non_public_address' },
  ];
  for (const item of cases) {
    t.mock.method(dns, 'lookup', async () => item.addresses);
    await rejectsSource(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'dns', item.reason);
  }
  assert.equal(h.requests.length, 0);
});

test('redirect denials retain their own stage and never expose the Location header', async t => {
  for (const [location, reason] of [
    ['', 'invalid_location'],
    ['https://private-rejected.example/SYNTHETIC-SECRET', 'host_not_allowed'],
    ['sandbox:/mnt/data/SYNTHETIC-SECRET.pptx', 'sandbox_reference'],
    ['http://[', 'invalid_location'],
  ]) await t.test(reason, async sub => {
    const h = harness(sub, [{ status: 302, headers: { location } }]);
    await rejectsSource(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'redirect_url', reason);
    assert.equal(h.requests.length, 1);
  });
});

test('download preserves exact binary bytes and pins a validated public DNS address with normal TLS validation', async t => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const h = harness(t, [{ headers: { 'content-length': '256' }, chunks: [bytes.subarray(0, 87), bytes.subarray(87)] }]);
  assert.deepEqual(await downloadChatGptFile(SOURCE, { maxBytes: 256 }), bytes);
  assert.deepEqual(h.lookups, ['files.oaiusercontent.com']);
  assert.deepEqual(h.requests[0].pinned, [null, PUBLIC_V4.address, 4]);
  assert.equal(h.requests[0].url.search, '?sig=SYNTHETIC-SECRET');
});

test('download accepts public IPv6 and empty files without changing bytes', async t => {
  const h = harness(t, [{ headers: { 'content-length': '0', 'content-encoding': 'identity' } }], [PUBLIC_V6]);
  assert.deepEqual(await downloadChatGptFile(SOURCE, { maxBytes: 1 }), Buffer.alloc(0));
  assert.deepEqual(h.requests[0].pinned, [null, PUBLIC_V6.address, 6]);
  let allResult: unknown;
  h.requests[0].options.lookup!('files.oaiusercontent.com', { all: true }, ((...args: unknown[]) => { allResult = args; }) as never);
  assert.deepEqual(allResult, [null, [PUBLIC_V6]]);
});

test('pinned lookup retains both address families for connection fallback without another DNS lookup', async t => {
  const h = harness(t, [{}], [PUBLIC_V6, PUBLIC_V4]);
  await downloadChatGptFile(SOURCE, { maxBytes: 1 });
  let result: unknown;
  h.requests[0].options.lookup!('files.oaiusercontent.com', { all: true }, ((...args: unknown[]) => { result = args; }) as never);
  assert.deepEqual(result, [null, [PUBLIC_V6, PUBLIC_V4]]);
  h.requests[0].options.lookup!('files.oaiusercontent.com', { family: 4 }, ((...args: unknown[]) => { result = args; }) as never);
  assert.deepEqual(result, [null, PUBLIC_V4.address, 4]);
  assert.equal(h.lookups.length, 1);
});

test('unsupported hosts, schemes, URL credentials, fragments, unsafe ports and normalization tricks are rejected before DNS', async t => {
  const h = harness(t);
  for (const source of [
    'sandbox:/mnt/data/file.pptx', 'file:///C:/file.pptx', 'http://files.oaiusercontent.com/a',
    'https://localhost/a', 'https://127.0.0.1/a', 'https://[::1]/a',
    'https://evil.example/a', 'https://files.oaiusercontent.com.evil.example/a',
    'https://sub.files.oaiusercontent.com/a', 'https://files.openai.com/a',
    'https://user:SYNTHETIC-SECRET@files.oaiusercontent.com/a', 'https://@files.oaiusercontent.com/a',
    SOURCE + '#fragment', SOURCE + '#', 'https://files.oaiusercontent.com:8443/a',
    'https://files.oaiuser\ncontent.com/a', ' https://files.oaiusercontent.com/a',
    'https://files.oaiusercontent.com/' + 'a'.repeat(16_384),
  ]) await rejectsSafe(downloadChatGptFile(source, { maxBytes: 10 }), 'FILE_IMPORT_SOURCE_DENIED');
  assert.equal(h.requests.length, 0); assert.equal(h.lookups.length, 0);
});

test('private, special-use, mapped, invalid and mixed DNS answers fail closed before connection', async t => {
  const h = harness(t);
  const denied = [
    '0.0.0.0', '10.2.3.4', '100.64.1.2', '100.127.255.255', '127.0.0.1', '169.254.169.254',
    '172.16.1.2', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.0.1', '192.88.99.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:104.18.12.32', '64:ff9b::7f00:1', 'fc00::1',
    'fe80::1', 'ff02::1', '2001::1', '2001:db8::1', '2002:7f00:1::', '3fff::1', '4000::1', 'not-an-ip',
  ];
  for (const address of denied) {
    t.mock.method(dns, 'lookup', async () => [{ address, family: address.includes(':') ? 6 : 4 }]);
    await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'FILE_IMPORT_SOURCE_DENIED');
  }
  t.mock.method(dns, 'lookup', async () => [PUBLIC_V4, { address: '127.0.0.1', family: 4 }]);
  await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'FILE_IMPORT_SOURCE_DENIED');
  t.mock.method(dns, 'lookup', async () => []);
  await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'FILE_IMPORT_SOURCE_DENIED');
  t.mock.method(dns, 'lookup', async () => [{ ...PUBLIC_V4, family: 6 }]);
  await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'FILE_IMPORT_SOURCE_DENIED');
  assert.equal(h.requests.length, 0);
});

test('redirects remain on the official host, repeat address validation and retain the final bytes', async t => {
  const h = harness(t, [{ status: 302, headers: { location: '/new?sig=SECOND-SYNTHETIC-SECRET' } }, { chunks: [Buffer.from('PPTX')] }]);
  assert.deepEqual(await downloadChatGptFile(SOURCE, { maxBytes: 4 }), Buffer.from('PPTX'));
  assert.equal(h.lookups.length, 2); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url.pathname, '/new');
});

test('redirect to a different host is denied without requesting it', async t => {
  const h = harness(t, [{ status: 307, headers: { location: 'https://localhost/?sig=SYNTHETIC-SECRET' } }]);
  await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'FILE_IMPORT_SOURCE_DENIED');
  assert.equal(h.requests.length, 1);
});

test('same-host DNS rebinding across a redirect is rejected', async t => {
  const h = harness(t, [{ status: 301, headers: { location: '/next' } }]);
  let calls = 0;
  t.mock.method(dns, 'lookup', async () => ++calls === 1 ? [PUBLIC_V4] : [{ address: '127.0.0.1', family: 4 }]);
  await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'FILE_IMPORT_SOURCE_DENIED');
  assert.equal(h.requests.length, 1); assert.equal(calls, 2);
});

test('redirect loops stop after at most three redirects', async t => {
  const h = harness(t, Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/loop' } })));
  await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'FILE_IMPORT_DOWNLOAD_FAILED');
  assert.equal(h.requests.length, 4);
});

test('malformed redirect destinations are rejected safely', async t => {
  for (const location of ['', '/next#', '/next\n', 'https://user:SYNTHETIC-SECRET@files.oaiusercontent.com/']) {
    await t.test(JSON.stringify(location), async sub => {
      const h = harness(sub, [{ status: 302, headers: { location } }]);
      await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'FILE_IMPORT_SOURCE_DENIED');
      assert.equal(h.requests.length, 1);
    });
  }
});

test('declared and streaming limits reject oversized downloads before returning any bytes', async t => {
  for (const reply of [
    { headers: { 'content-length': '11' } },
    { chunks: [Buffer.alloc(5), Buffer.alloc(6)] },
  ]) await t.test('limit', async sub => {
    const h = harness(sub, [reply]);
    await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'FILE_IMPORT_TOO_LARGE');
    assert.equal(h.requests[0].destroyed, true);
  });
});

test('partial, length-mismatched and malformed-length responses cannot be saved as complete files', async t => {
  const replies: Reply[] = [
    { headers: { 'content-length': '2' }, chunks: [Buffer.from('1')] },
    { headers: { 'content-length': '1' }, chunks: [Buffer.from('12')] },
    { headers: { 'content-length': '-1' } }, { headers: { 'content-length': '99999999999999999999' } },
    { incomplete: true, chunks: [Buffer.from('partial')] },
  ];
  for (const reply of replies) await t.test('integrity', async sub => {
    harness(sub, [reply]);
    await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'FILE_IMPORT_INTEGRITY_ERROR');
  });
});

test('HTTP failures, partial status and compressed content are rejected without exposing response data', async t => {
  for (const reply of [{ status: 401 }, { status: 403 }, { status: 206 }, { status: 500 }, { headers: { 'content-encoding': 'gzip' } }]) {
    await t.test('HTTP error', async sub => {
      harness(sub, [{ ...reply, chunks: [Buffer.from(SOURCE)] }]);
      await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'FILE_IMPORT_DOWNLOAD_FAILED');
    });
  }
});

test('HTTP rejection exposes only the fixed stage and numeric status, without credentials or response text', async t => {
  harness(t, [{ status: 403, headers: { 'x-secret': 'SYNTHETIC-SECRET' }, chunks: [Buffer.from(SOURCE)] }]);
  await assert.rejects(downloadChatGptFile(SOURCE, { maxBytes: 100 }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'FILE_IMPORT_DOWNLOAD_FAILED');
    assert.deepEqual(error.details, { stage: 'http', http_status: 403 });
    assert.equal(JSON.stringify(error).includes('SYNTHETIC-SECRET'), false);
    return true;
  });
});

test('native DNS, request, stream and synchronous transport errors never leak signed URL credentials', async t => {
  for (const kind of ['dns', 'request', 'response', 'synchronous']) await t.test(kind, async sub => {
    harness(sub, [{ requestError: kind === 'request', responseError: kind === 'response' }]);
    if (kind === 'dns') sub.mock.method(dns, 'lookup', async () => { throw new Error(SOURCE); });
    if (kind === 'synchronous') sub.mock.method(https, 'request', () => { throw new Error(SOURCE); });
    await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10 }), 'FILE_IMPORT_DOWNLOAD_FAILED');
  });
});

test('the total deadline covers slow DNS and prevents a connection after its late answer', async t => {
  const h = harness(t);
  t.mock.method(dns, 'lookup', async () => { await delay(40); return [PUBLIC_V4]; });
  await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10, timeoutMs: 10 }), 'FILE_IMPORT_TIMEOUT');
  await delay(50);
  assert.equal(h.requests.length, 0);
});

test('the total deadline destroys a stalled response and is not reset after redirects', async t => {
  await t.test('body stall', async sub => {
    const h = harness(sub, [{ stall: true }]);
    await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10, timeoutMs: 10 }), 'FILE_IMPORT_TIMEOUT');
    assert.equal(h.requests[0].destroyed, true);
  });
  await t.test('redirect deadline', async sub => {
    const h = harness(sub, [{ status: 302, headers: { location: '/new' }, waitMs: 30 }, { waitMs: 50 }]);
    await rejectsSafe(downloadChatGptFile(SOURCE, { maxBytes: 10, timeoutMs: 60 }), 'FILE_IMPORT_TIMEOUT');
    assert.equal(h.requests.length, 2); assert.equal(h.requests[1].destroyed, true);
  });
});

test('invalid configured size and timeout limits fail before DNS', async t => {
  const h = harness(t);
  for (const options of [{ maxBytes: 0 }, { maxBytes: -1 }, { maxBytes: 1.5 }, { maxBytes: Infinity },
    { maxBytes: 10, timeoutMs: 0 }, { maxBytes: 10, timeoutMs: 300_001 }]) {
    await rejectsSafe(downloadChatGptFile(SOURCE, options), 'FILE_IMPORT_INVALID_ARGUMENT');
  }
  assert.equal(h.requests.length, 0); assert.equal(h.lookups.length, 0);
});
