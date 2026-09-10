import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { renderLocalPanel } from '../src/local-panel-ui.js';

type Handler = (event: any) => unknown;
class Element {
  ownText = '';
  children: Element[] = [];
  disabled = false; hidden = false; value = ''; className = ''; type = '';
  focused = false; selected = false;
  dataset: Record<string, string> = {};
  listeners = new Map<string, Handler[]>();
  constructor(readonly tagName = 'div') {}
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  set innerHTML(_value: string) { throw new Error('HTML injection must never be used by this panel'); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; this.ownText = ''; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  addEventListener(event: string, handler: Handler) { this.listeners.set(event, [...this.listeners.get(event) ?? [], handler]); }
  async trigger(event: string) {
    if (this.disabled) return;
    for (const handler of this.listeners.get(event) ?? []) await handler({ target: this, preventDefault() {} });
  }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
}
const TOKEN = 'synthetic-local-panel-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SECRET = 'CONFIGURATION_SECRET_MUST_NOT_BE_RENDERED';
const DEVICE = '11111111-2222-4333-8444-555555555555';
const SESSION = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const JOB = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const PATH = '论文/报告.pdf';
const ABSOLUTE = 'E:\\研究资料\\论文\\报告.pdf';
const storedKey = 'webcodex.local-panel.token.v1';

function status(overrides: Record<string, unknown> = {}) {
  return { version: 'test-local-panel', device: { id: DEVICE, name: 'Windows 研究电脑' }, config_path: 'E:\\WebCodex\\config.json', execution_mode: 'disabled',
    workspaces: [{ workspace_id: 'research', name: '研究资料', root: 'E:\\研究资料', read_only: true, enabled: true, status: 'available', available: true },
      { workspace_id: 'code', name: '代码', root: 'D:\\代码', read_only: false, enabled: true, status: 'available', available: true },
      { workspace_id: 'offline', name: '离线目录', root: 'F:\\离线', read_only: false, enabled: true, status: 'missing', available: false }],
    tunnel: { state: 'connected_tools_called', connected: true, live: true, mcp_ready: true, poll_fresh: true, successful_tool_calls: 3 },
    jobs: { available: true, read_only: true, recorded_state_only: true, jobs: [{ job_id: JOB, workspace_id: 'research', executable_alias: 'node', status: 'running', exit_code: null }] },
    diagnostics: { available: true, enabled: true, events: [{ started_at: '2026-09-09T12:00:00Z', method: 'tools/call', tool: 'fs_list', outcome: 'responded', stage: 'response_sent', error_code: null }] },
    codex: { enabled: true, home: 'D:\\CodexHome', read_only: true }, ...overrides };
}
function fileInfo(overrides: Record<string, unknown> = {}) {
  return { workspace_id: 'research', path: PATH, absolute_path: ABSOLUTE, name: '报告.pdf', size_bytes: 18 * 1048576,
    mime_type: 'application/pdf', sha256: 'a'.repeat(64), hash_status: 'verified', upload_status: 'not_uploaded', model_access: 'unverified', ...overrides };
}
function reply(data: unknown, status = 200) { return { status, ok: status >= 200 && status < 300, json: async () => data }; }
type FetchHandler = (url: URL, init: any) => unknown | Promise<unknown>;
function harness(options: { hash?: string; stored?: string; fetch?: FetchHandler; clipboard?: boolean; storageThrows?: boolean; historyThrows?: boolean } = {}) {
  const html = renderLocalPanel();
  const elements = new Map<string, Element>();
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1]); element.disabled = /\bdisabled\b/.test(match[2]); element.hidden = /\bhidden\b/.test(match[2]);
    element.value = /\bvalue="([^"]*)"/.exec(match[2])?.[1] ?? ''; elements.set(match[3], element);
  }
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(html)?.[1]; assert.ok(script);
  const storage = new Map(options.stored ? [[storedKey, options.stored]] : []);
  const location = { origin: 'http://127.0.0.1:18767', pathname: '/', search: '', hash: options.hash ?? '#token=' + TOKEN };
  const requests: Array<{ url: URL; init: any }> = [], copied: string[] = [], history: string[] = [], sequence: string[] = [];
  const timers = new Map<number, () => void>(); let timer = 0;
  const defaultFetch: FetchHandler = url => {
    switch (url.pathname) {
      case '/api/status': return reply(status());
      case '/api/files': return reply({ workspace_id: url.searchParams.get('workspace_id'), path: url.searchParams.get('path'), entries: [
        { name: '论文', path: '论文', type: 'directory' }, { name: '报告.pdf', path: PATH, type: 'file', size_bytes: 18 * 1048576 },
      ] });
      case '/api/file-info': return reply(fileInfo());
      case '/api/reveal': return reply({ ok: true });
      case '/api/codex/sessions': return reply({ sessions: [{ session_id: SESSION, title: '论文项目继续', workspace_id: 'research', updated_at: '2026-09-09T12:00:00Z' }], next_cursor: null });
      case '/api/job-output': return reply({ available: true, job_id: JOB, text: 'Recorded output only', partial: true, read_only: true });
      default: throw new Error('Unexpected endpoint');
    }
  };
  vm.runInNewContext(script, {
    document: { getElementById: (id: string) => { assert.ok(elements.has(id), id); return elements.get(id); }, createElement: (tag: string) => new Element(tag) },
    location,
    history: { replaceState: (_state: unknown, _unused: string, url: string) => { if (options.historyThrows) throw new Error('disabled'); history.push(url); sequence.push('clear-fragment'); location.hash = ''; } },
    sessionStorage: {
      getItem: (key: string) => { if (options.storageThrows) throw new Error('unavailable'); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (options.storageThrows) throw new Error('unavailable'); storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    navigator: options.clipboard === false ? {} : { clipboard: { writeText: async (value: string) => { copied.push(value); } } },
    fetch: async (url: string, init: any) => { sequence.push('fetch'); const parsed = new URL(url); requests.push({ url: parsed, init }); await Promise.resolve(); return options.fetch ? options.fetch(parsed, init) : defaultFetch(parsed, init); },
    URL, URLSearchParams, AbortController,
    setTimeout: (fn: () => void) => { timers.set(++timer, fn); return timer; }, clearTimeout: (id: number) => timers.delete(id),
  }, { timeout: 3000 });
  const get = (id: string) => elements.get(id)!;
  const button = (container: string, label: string) => { const result = get(container).descendants().find(item => item.tagName === 'button' && item.textContent === label); assert.ok(result, label); return result; };
  return { html, get, button, requests, copied, storage, history, location, sequence, defaultFetch,
    allText: () => [...elements.values()].map(element => element.textContent + element.value).join('\n'),
    settle: async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); },
    expire: () => { for (const callback of timers.values()) callback(); },
  };
}

test('local panel is deterministic, self-contained and has no external resources or inline handlers', () => {
  const html = renderLocalPanel(); assert.equal(html, renderLocalPanel());
  assert.match(html, /<html lang="zh-CN">/); assert.match(html, /name="referrer" content="no-referrer"/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|<iframe|<img|\bonclick=|\bstyle=|innerHTML|insertAdjacentHTML|localStorage|WebSocket|XMLHttpRequest|uploadFile\(/);
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.match(html, /不会自动上传/); assert.match(html, /ChatGPT 网页点击附件按钮/);
  assert.doesNotMatch(html, /sk-[A-Za-z0-9]|tunnel_[a-z0-9]{20,}/);
});

test('local panel removes a fragment token before fetching and authenticates only same-origin API requests', async () => {
  const h = harness({ stored: 'old-token-must-be-replaced' }); await h.settle();
  assert.equal(h.location.hash, ''); assert.deepEqual(h.history, ['/']); assert.equal(h.sequence[0], 'clear-fragment');
  assert.equal(h.storage.get(storedKey), TOKEN);
  assert.equal(h.requests.length, 3);
  for (const { url, init } of h.requests) {
    assert.equal(url.origin, 'http://127.0.0.1:18767'); assert.ok(url.pathname.startsWith('/api/')); assert.equal(url.href.includes(TOKEN), false);
    assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(init.credentials, 'omit'); assert.equal(init.mode, 'same-origin'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(init.body, undefined);
  }
  assert.equal(h.allText().includes(TOKEN), false);
  assert.equal(h.get('copy-path').disabled, true); assert.equal(h.get('reveal').disabled, true);
  assert.equal(h.get('device-name').textContent, 'Windows 研究电脑');
  assert.equal(h.get('device-id').textContent, DEVICE);
  assert.match(h.get('tunnel-note').textContent, /本机 MCP：已就绪/);
  assert.match(h.get('workspace-rows').textContent, /只读/); assert.match(h.get('workspace-rows').textContent, /目录不存在/);
  assert.equal(h.get('workspace').children.find(option => option.value === 'offline')?.disabled, true);
});

test('local panel requires its own token and supports session refresh without persistent storage', async () => {
  const missing = harness({ hash: '' }); await missing.settle(); assert.equal(missing.requests.length, 0);
  assert.match(missing.get('notice').textContent, /本机启动命令/);
  const resumed = harness({ hash: '', stored: TOKEN }); await resumed.settle(); assert.equal(resumed.requests.length, 3); assert.deepEqual(resumed.history, []);
  const unavailableStorage = harness({ storageThrows: true }); await unavailableStorage.settle(); assert.equal(unavailableStorage.requests.length, 3);
  const failedRemoval = harness({ historyThrows: true }); await failedRemoval.settle(); assert.equal(failedRemoval.requests.length, 0); assert.equal(failedRemoval.get('refresh').disabled, true);
  const bad = harness({ hash: '#token=bad%0Avalue' }); await bad.settle(); assert.equal(bad.requests.length, 0); assert.equal(bad.location.hash, '');
});

test('local panel renders untrusted names as text and ignores secret-shaped fields outside its display contract', async () => {
  const malicious = '<img src=x onerror=alert(1)> & <script>not code</script>';
  let h!: ReturnType<typeof harness>;
  h = harness({ fetch: url => {
    if (url.pathname === '/api/status') return reply(status({ device: { id: DEVICE, name: malicious, apiKey: SECRET }, apiKey: SECRET,
      diagnostics: { enabled: true, available: true, events: [{ method: malicious, args: { apiKey: SECRET } }] } }));
    return h.defaultFetch(url, {});
  } }); await h.settle();
  assert.equal(h.get('device-name').textContent, malicious); assert.equal(h.get('device-name').children.length, 0);
  assert.match(h.get('diagnostic-rows').textContent, /<img src=x/); assert.equal(h.allText().includes(SECRET), false);
});

test('local panel reads metadata on selection and only copies or reveals after the matching click', async () => {
  const h = harness(); await h.settle();
  await h.button('file-rows', '报告.pdf').trigger('click');
  assert.equal(h.requests.filter(request => request.init.method === 'POST').length, 1);
  assert.equal(h.get('file-absolute').value, ABSOLUTE); assert.equal(h.get('file-info').hidden, false);
  assert.equal(h.get('file-size').textContent, '18.0 MiB'); assert.match(h.get('file-feedback').textContent, /尚未上传/);
  assert.deepEqual(h.copied, []); assert.equal(h.requests.some(request => request.url.pathname === '/api/reveal'), false);
  await h.get('copy-path').trigger('click'); assert.deepEqual(h.copied, [ABSOLUTE]);
  await h.get('reveal').trigger('click');
  const post = h.requests.filter(request => request.init.method === 'POST');
  assert.deepEqual(post.map(request => request.url.pathname), ['/api/file-info', '/api/reveal']);
  for (const request of post) assert.deepEqual(JSON.parse(request.init.body), { workspace_id: 'research', path: PATH });
  assert.match(h.get('file-feedback').textContent, /已请求打开/);
});

test('local panel keeps large original files usable when SHA-256 was not computed', async () => {
  let h!: ReturnType<typeof harness>;
  h = harness({ clipboard: false, fetch: (url, init) => url.pathname === '/api/file-info'
    ? reply(fileInfo({ size_bytes: 3 * 1073741824, sha256: null, hash_status: 'not_computed_size_limit' })) : h.defaultFetch(url, init) });
  await h.settle(); await h.button('file-rows', '报告.pdf').trigger('click');
  assert.equal(h.get('file-size').textContent, '3.0 GiB'); assert.match(h.get('file-hash').textContent, /未计算/);
  assert.equal(h.get('copy-path').disabled, false); assert.equal(h.get('reveal').disabled, false);
  await h.get('copy-path').trigger('click'); assert.equal(h.get('file-absolute').selected, true); assert.match(h.get('file-feedback').textContent, /Ctrl\+C/);
});

test('local panel can use an exact relative file path and never interprets it as an API destination', async () => {
  const h = harness(); await h.settle();
  h.get('directory').value = '.\\论文\\报告.pdf'; await h.get('inspect-path').trigger('click');
  assert.deepEqual(JSON.parse(h.requests.at(-1)!.init.body), { workspace_id: 'research', path: PATH });
  const before = h.requests.length;
  for (const path of ['../secret', 'E:\\outside.pdf', '/outside.pdf']) { h.get('directory').value = path; await h.get('inspect-path').trigger('click'); }
  assert.equal(h.requests.length, before);
  h.get('directory').value = 'https://untrusted.example/a?token=unknown'; await h.get('path-form').trigger('submit');
  const last = h.requests.at(-1)!; assert.equal(last.url.origin, 'http://127.0.0.1:18767'); assert.equal(last.url.pathname, '/api/files');
  assert.equal(last.url.searchParams.get('path'), 'https://untrusted.example/a?token=unknown');
});

test('local panel discards stale file metadata after switching workspaces', async () => {
  let release!: (value: unknown) => void; let h!: ReturnType<typeof harness>;
  h = harness({ fetch: (url, init) => url.pathname === '/api/file-info' ? new Promise(resolve => { release = resolve; }) : h.defaultFetch(url, init) });
  await h.settle(); const pending = h.button('file-rows', '报告.pdf').trigger('click'); await h.settle();
  h.get('workspace').value = 'code'; await h.get('workspace').trigger('change');
  release(reply(fileInfo())); await pending; await h.settle();
  assert.equal(h.get('file-info').hidden, true); assert.equal(h.get('file-absolute').value, ''); assert.equal(h.get('reveal').disabled, true);
  assert.equal(h.requests.filter(request => request.url.pathname === '/api/files').at(-1)!.url.searchParams.get('workspace_id'), 'code');
});

test('local panel rejects mismatched file identities without enabling local actions', async () => {
  let h!: ReturnType<typeof harness>;
  h = harness({ fetch: (url, init) => url.pathname === '/api/file-info' ? reply(fileInfo({ workspace_id: 'another-device-workspace' })) : h.defaultFetch(url, init) });
  await h.settle(); await h.button('file-rows', '报告.pdf').trigger('click');
  assert.equal(h.get('reveal').disabled, true); assert.equal(h.get('copy-path').disabled, true); assert.match(h.get('file-feedback').textContent, /不匹配/);
});

test('local panel recovers from a failed request and clears rejected authentication without exposing errors', async () => {
  let count = 0; let h!: ReturnType<typeof harness>;
  h = harness({ fetch: (url, init) => { if (url.pathname === '/api/status' && count++ === 0) throw new Error(SECRET); return h.defaultFetch(url, init); } });
  await h.settle(); assert.match(h.get('notice').textContent, /重试/); assert.equal(h.allText().includes(SECRET), false); assert.equal(h.get('refresh').disabled, false);
  await h.get('refresh').trigger('click'); assert.equal(h.get('connection').textContent, '本机已连接');
  const unauthorized = harness({ fetch: () => reply({ ok: false, error: { message: SECRET } }, 401) }); await unauthorized.settle();
  assert.equal(unauthorized.storage.has(storedKey), false); assert.match(unauthorized.get('notice').textContent, /凭据已失效/);
  assert.equal(unauthorized.allText().includes(SECRET), false); const requests = unauthorized.requests.length;
  await unauthorized.get('refresh').trigger('click'); assert.equal(unauthorized.requests.length, requests);
});

test('local panel copies a reviewable Codex handoff request without calling MCP or mutating session state', async () => {
  const h = harness(); await h.settle(); const before = h.requests.length;
  await h.button('session-rows', '复制接续请求').trigger('click');
  assert.equal(h.requests.length, before); assert.equal(h.copied.length, 1);
  const prompt = h.copied[0]; assert.match(prompt, /system_status/); assert.ok(prompt.includes(DEVICE)); assert.ok(prompt.includes(JSON.stringify({ session_id: SESSION })));
  assert.match(prompt, /codex_session_handoff/); assert.match(prompt, /不自动重放旧命令/);
  assert.equal(prompt.includes(TOKEN), false); assert.equal(prompt.includes('论文项目继续'), false);
  assert.equal(h.get('handoff-preview').hidden, false); assert.equal(h.get('handoff-request').value, prompt);
});

test('local panel follows opaque session cursors within the selected workspace', async () => {
  let h!: ReturnType<typeof harness>;
  h = harness({ fetch: (url, init) => url.pathname === '/api/codex/sessions' ? reply({
    sessions: [], next_cursor: url.searchParams.has('cursor') ? null : 'opaque+cursor/with?values',
  }) : h.defaultFetch(url, init) });
  await h.settle(); assert.equal(h.get('sessions-next').hidden, false); assert.match(h.get('session-empty').textContent, /下一页/);
  assert.match(h.get('session-feedback').textContent, /尚未遍历整个工作区/);
  assert.doesNotMatch(h.get('session-empty').textContent, /当前工作区没有/);
  await h.get('sessions-next').trigger('click'); const last = h.requests.at(-1)!;
  assert.equal(last.url.pathname, '/api/codex/sessions'); assert.equal(last.url.searchParams.get('workspace_id'), 'research');
  assert.equal(last.url.searchParams.get('cursor'), 'opaque+cursor/with?values'); assert.equal(h.get('sessions-next').hidden, true);
});

test('local panel distinguishes changing history indexes from an empty workspace and refreshes from the first page', async () => {
  let h!: ReturnType<typeof harness>, rejectNext = true, requests = 0;
  h = harness({ fetch: (url, init) => {
    if (url.pathname === '/api/codex/sessions') {
      requests++;
      if (rejectNext) return reply({ ok: false, error: { code: 'HISTORY_INDEX_CHANGED', message: SECRET }, recovery: 'refresh_sessions' }, 409);
    }
    return h.defaultFetch(url, init);
  } });
  await h.settle(); assert.equal(requests, 1, 'Index changes require a visible refresh, not an automatic unbounded retry.');
  assert.match(h.get('session-empty').textContent, /会话索引已更新/); assert.match(h.get('session-feedback').textContent, /刷新列表/);
  assert.equal(h.allText().includes(SECRET), false); assert.equal(h.get('sessions-next').hidden, true);
  rejectNext = false; await h.get('sessions-refresh').trigger('click'); assert.equal(requests, 2);
  assert.equal(h.requests.at(-1)!.url.searchParams.has('cursor'), false); assert.equal(h.get('session-empty').hidden, true);
  assert.match(h.get('session-rows').textContent, /论文项目继续/);
});

test('local panel maps only recognized session error codes to actionable local guidance', async () => {
  for (const [code, expected] of [['INVALID_CURSOR', /刷新列表/], ['HISTORY_PATH_DENIED', /访问权限/], ['CODEX_SESSIONS_DISABLED', /未启用/], ['NOT_FOUND', /目录已不存在/], ['HISTORY_SCAN_LIMIT', /扫描.*预算/], ['PANEL_BUSY', /其他请求/], [SECRET, /暂时无法完成/]] as const) {
    let h!: ReturnType<typeof harness>;
    h = harness({ fetch: (url, init) => url.pathname === '/api/codex/sessions' ? reply({ ok: false, error: { code, message: SECRET } }, 422) : h.defaultFetch(url, init) });
    await h.settle(); assert.match(h.get('session-feedback').textContent, expected);
    assert.equal(h.allText().includes(SECRET), false); assert.equal(h.get('session-empty').hidden, false);
  }
});

test('local panel loads only the selected recorded job output and keeps it inert', async () => {
  let h!: ReturnType<typeof harness>; const output = '<script>alert(1)</script>\nRecorded output';
  h = harness({ fetch: (url, init) => url.pathname === '/api/job-output' ? reply({ available: true, job_id: JOB, text: output, partial: true }) : h.defaultFetch(url, init) });
  await h.settle(); assert.equal(h.requests.some(request => request.url.pathname === '/api/job-output'), false);
  await h.button('job-rows', '查看输出').trigger('click');
  const last = h.requests.at(-1)!; assert.equal(last.init.method, 'GET'); assert.equal(last.url.searchParams.get('job_id'), JOB);
  assert.equal(h.get('job-output').textContent, output); assert.equal(h.get('job-output').children.length, 0);
  assert.match(h.get('job-feedback').textContent, /开头部分/); assert.match(h.get('job-feedback').textContent, /当前作业状态请通过 MCP 查询/);
});
