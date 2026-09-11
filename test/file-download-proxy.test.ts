import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import tls from 'node:tls';
import { test, type TestContext } from 'node:test';
import { AppError } from '../src/errors.js';
import { downloadChatGptFile } from '../src/file-download.js';

const SOURCE = 'https://files.oaiusercontent.com/generated?sig=SYNTHETIC-FILE-SECRET';
const PROXY = 'http://127.0.0.1:7890';
const PUBLIC_V4 = { address: '104.18.12.32', family: 4 };
const PUBLIC_V6 = { address: '2606:4700::6812:c20', family: 6 };
type Scenario = { proxyStatus?: number; connectHead?: string; proxyError?: boolean; stallProxy?: boolean;
  tlsError?: boolean; authorized?: boolean; stallTls?: boolean; proxyClose?: boolean; tlsClose?: boolean;
  addresses?: { address: string; family: number }[]; redirect?: string };

function harness(t: TestContext, scenario: Scenario = {}) {
  const connections: { url: URL; options: https.RequestOptions; destroyed: boolean }[] = [];
  const gets: { url: URL; options: https.RequestOptions }[] = [];
  const secureOptions: tls.ConnectionOptions[] = [];
  const rawSockets: PassThrough[] = [], tlsSockets: PassThrough[] = [];
  const sequence: string[] = [];
  t.mock.method(dns, 'lookup', async () => scenario.addresses ?? [PUBLIC_V6, PUBLIC_V4]);
  const requestMock = (url: URL, options: https.RequestOptions, callback?: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    if (options.method === 'CONNECT') {
      const capture = { url, options, destroyed: false }; connections.push(capture);
      assert.equal(url.search, ''); assert.equal(url.password, ''); assert.equal(url.username, '');
      assert.equal(options.agent, false);
      assert.equal(JSON.stringify(options).includes('SYNTHETIC-FILE-SECRET'), false);
      request.destroy = () => { capture.destroyed = true; };
      request.end = () => queueMicrotask(() => {
        sequence.push('CONNECT');
        if (scenario.proxyError) { request.emit('error', new Error('Secret proxy error ' + SOURCE)); return; }
        if (scenario.proxyClose) { request.emit('close'); return; }
        if (scenario.stallProxy) return;
        const socket = new PassThrough(); rawSockets.push(socket);
        request.emit('connect', { statusCode: scenario.proxyStatus ?? 200 }, socket, Buffer.from(scenario.connectHead ?? ''));
      });
    } else {
      sequence.push('GET');
      gets.push({ url, options });
      assert.equal(options.method, 'GET');
      assert.equal(url.hostname, 'files.oaiusercontent.com');
      assert.equal(options.rejectUnauthorized, true);
      assert.deepEqual(options.headers, { 'Accept-Encoding': 'identity' });
      assert.ok(options.agent instanceof https.Agent);
      const socket = (options.agent.createConnection as unknown as () => unknown)();
      assert.equal(socket, tlsSockets.at(-1));
      const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string>; complete: boolean };
      response.statusCode = scenario.redirect && gets.length === 1 ? 302 : 200;
      response.headers = response.statusCode === 302 ? { location: scenario.redirect! } : { 'content-length': '4' };
      response.complete = true;
      request.destroy = () => { response.destroy(); };
      request.end = () => queueMicrotask(() => { callback!(response); if (!response.destroyed) response.end(Buffer.from([0x50, 0x4b, 0, 255])); });
    }
    return request;
  };
  t.mock.method(http, 'request', requestMock);
  t.mock.method(https, 'request', requestMock);
  t.mock.method(tls, 'connect', (options: tls.ConnectionOptions) => {
    secureOptions.push(options);
    assert.equal(options.servername, 'files.oaiusercontent.com');
    assert.equal(options.rejectUnauthorized, true);
    assert.deepEqual(options.ALPNProtocols, ['http/1.1']);
    assert.equal(options.socket, rawSockets.at(-1));
    assert.equal(JSON.stringify(options).includes('SYNTHETIC-FILE-SECRET'), false);
    const secured = new PassThrough() as PassThrough & { authorized: boolean };
    secured.authorized = scenario.authorized ?? true;
    tlsSockets.push(secured);
    queueMicrotask(() => {
      if (scenario.tlsError) { secured.emit('error', new Error('Secret TLS error ' + SOURCE)); return; }
      if (scenario.tlsClose) { secured.destroy(); return; }
      if (scenario.stallTls) return;
      sequence.push('TLS verified'); secured.emit('secureConnect');
    });
    return secured;
  });
  return { connections, gets, secureOptions, rawSockets, tlsSockets, sequence };
}

async function rejectSafe(run: Promise<unknown>, code: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AppError); assert.equal(error.code, code);
    assert.equal(JSON.stringify(error).includes('SYNTHETIC-FILE-SECRET'), false);
    assert.equal(error.message.includes('https://'), false);
    assert.equal((error as Error & { cause?: unknown }).cause, undefined);
    return true;
  });
}

test('configured HTTP proxy receives only a pinned public IP before end-to-end TLS and exact file bytes', async t => {
  const h = harness(t);
  assert.deepEqual(await downloadChatGptFile(SOURCE, { maxBytes: 4, proxyUrl: PROXY }), Buffer.from([0x50, 0x4b, 0, 255]));
  assert.deepEqual(h.sequence, ['CONNECT', 'TLS verified', 'GET']);
  assert.equal(h.connections[0].url.hostname, '127.0.0.1');
  assert.equal(h.connections[0].options.path, '104.18.12.32:443');
  assert.deepEqual(h.connections[0].options.headers, { Host: '104.18.12.32:443' });
  assert.equal(h.gets[0].url.search, '?sig=SYNTHETIC-FILE-SECRET');
  assert.equal(h.tlsSockets[0].destroyed, true);
});

test('configured HTTPS proxy verifies its own certificate and supports an IPv6 CONNECT target', async t => {
  const h = harness(t, { addresses: [PUBLIC_V6] });
  await downloadChatGptFile(SOURCE, { maxBytes: 4, proxyUrl: 'https://proxy.example:8443' });
  assert.equal(h.connections[0].options.rejectUnauthorized, true);
  assert.equal(h.connections[0].options.path, '[2606:4700::6812:c20]:443');
  assert.deepEqual(h.connections[0].options.headers, { Host: '[2606:4700::6812:c20]:443' });
});

test('file redirects establish fresh pinned CONNECT and TLS before forwarding the next signed URL', async t => {
  const h = harness(t, { redirect: '/redirected?sig=OTHER-SYNTHETIC-FILE-SECRET' });
  await downloadChatGptFile(SOURCE, { maxBytes: 4, proxyUrl: PROXY });
  assert.equal(h.connections.length, 2); assert.equal(h.secureOptions.length, 2); assert.equal(h.gets.length, 2);
  assert.deepEqual(h.sequence, ['CONNECT', 'TLS verified', 'GET', 'CONNECT', 'TLS verified', 'GET']);
});

test('proxy cannot bypass file-source DNS and hostname restrictions', async t => {
  const h = harness(t, { addresses: [{ address: '127.0.0.1', family: 4 }] });
  await rejectSafe(downloadChatGptFile(SOURCE, { maxBytes: 4, proxyUrl: PROXY }), 'FILE_IMPORT_SOURCE_DENIED');
  assert.equal(h.connections.length, 0);
  await rejectSafe(downloadChatGptFile('https://other.example/', { maxBytes: 4, proxyUrl: PROXY }), 'FILE_IMPORT_SOURCE_DENIED');
  assert.equal(h.connections.length, 0);
});

test('unsupported proxy schemes, paths and credentials fail before CONNECT', async t => {
  const h = harness(t);
  for (const proxyUrl of ['socks5://127.0.0.1:7890', 'http://name:SYNTHETIC-FILE-SECRET@127.0.0.1:7890',
    'http://127.0.0.1:7890/path', 'http://127.0.0.1:7890/?key=SYNTHETIC-FILE-SECRET', 'http://127.0.0.1:7890/#',
    'http://127.0.0.1:7890/\n', 'http://@127.0.0.1:7890']) {
    await rejectSafe(downloadChatGptFile(SOURCE, { maxBytes: 4, proxyUrl }), 'FILE_IMPORT_PROXY_INVALID');
  }
  assert.equal(h.connections.length, 0); assert.equal(h.gets.length, 0);
});

test('CONNECT rejection, unexpected bytes, native errors and TLS certificate failures never send the file URL', async t => {
  for (const scenario of [
    { proxyStatus: 407 }, { proxyStatus: 500 }, { connectHead: 'unexpected data' }, { proxyError: true },
    { tlsError: true }, { authorized: false }, { proxyClose: true }, { tlsClose: true },
  ]) await t.test('rejected tunnel', async sub => {
    const h = harness(sub, scenario);
    await rejectSafe(downloadChatGptFile(SOURCE, { maxBytes: 4, proxyUrl: PROXY }), 'FILE_IMPORT_DOWNLOAD_FAILED');
    assert.equal(h.gets.length, 0);
    assert.equal(h.connections[0].destroyed, true);
    assert.ok(h.rawSockets.every(socket => socket.destroyed));
    assert.ok(h.tlsSockets.every(socket => socket.destroyed));
  });
});

test('the existing total deadline cancels stalled proxy CONNECT and TLS handshakes without leaking URL credentials', async t => {
  for (const scenario of [{ stallProxy: true }, { stallTls: true }]) await t.test('deadline', async sub => {
    const h = harness(sub, scenario);
    await rejectSafe(downloadChatGptFile(SOURCE, { maxBytes: 4, proxyUrl: PROXY, timeoutMs: 15 }), 'FILE_IMPORT_TIMEOUT');
    assert.equal(h.gets.length, 0);
    assert.equal(h.connections[0].destroyed, true);
    assert.ok(h.rawSockets.every(socket => socket.destroyed));
    assert.ok(h.tlsSockets.every(socket => socket.destroyed));
  });
});
