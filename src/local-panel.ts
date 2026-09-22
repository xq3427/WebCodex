import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, lstatSync, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { AppError } from './errors.js';
import { WorkspacePaths } from './paths.js';
import { workspaceHealth, inspectWorkspace, bindWorkspaceRuntime } from './workspace-health.js';
import { readMcpDiagnostics } from './mcp-diagnostics.js';
import { readTunnelStatus } from './tunnel.js';
import { CodexSessionService } from './codex-sessions.js';
import { redactSessionText } from './codex-redaction.js';
import { renderLocalPanel } from './local-panel-ui.js';
import { renderLocalAdmin } from './local-admin-ui.js';
import { loadConfig } from './config.js';
import { readConfigDocument, validatePanelConfigBaseline } from './config-admin.js';
import type { PanelConfigService } from './panel-config.js';
import { safePanelDetails } from './panel-validation.js';
import type { PanelRuntime } from './panel-runtime.js';
import { VERSION } from './version.js';
import type { AppConfig, Store } from './types.js';
import { checkLocalAccess } from './local-access.js';

const BODY_LIMIT = 4096;
const ADMIN_BODY_LIMIT = 262144;
const safeCode = (error: unknown) => error instanceof AppError && /^[A-Z_]{1,80}$/.test(error.code) ? error.code
  : ({ ENOENT: 'NOT_FOUND', EACCES: 'ACCESS_DENIED', EPERM: 'ACCESS_DENIED' } as Record<string, string>)[(error as NodeJS.ErrnoException)?.code ?? ''] ?? 'PANEL_REQUEST_FAILED';
const same = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && (a.dev === b.dev || process.platform === 'win32' && (a.dev === 0n || b.dev === 0n));
const safeText = (value: unknown, max = 512) => redactSessionText(String(value ?? '').slice(0, max * 2)).text.slice(0, max);

/**
 * Parse an HTTP authority that is safe for the loopback-only panel. Browsers
 * and SSH port forwarding can spell the endpoint as 127.0.0.1 or localhost,
 * and a forwarded local port can differ from the remote listening port. The
 * caller separately requires Host and Origin to use the same parsed port.
 */
function loopbackAuthorityPort(value: string | undefined): number | null {
  if (!value) return null;
  try {
    const parsed = new URL(value.includes('://') ? value : 'http://' + value);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'http:' || !/^\d+$/.test(parsed.port) || parsed.username !== '' || parsed.password !== ''
      || (parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search !== '' || parsed.hash !== ''
      || (hostname !== '127.0.0.1' && hostname !== 'localhost')) return null;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch { return null; }
}

/** Allow the local repair UI to open when an optional history root has disappeared. */
export async function loadPanelViewConfig(configPath: string) {
  try { return await loadConfig(configPath, { workspaceDiagnostics: true }); }
  catch {
    const document = await readConfigDocument(configPath);
    return await validatePanelConfigBaseline(document.raw, document.fullPath);
  }
}

/** No StateStore lease, migrations, stale-job recovery, or write-capable database is opened. */
function readJobs(config: AppConfig, jobId?: string) {
  const empty = { available: false, read_only: true, recorded_state_only: true, jobs: [] as unknown[] };
  try {
    let current = path.parse(config.stateDir).root;
    for (const part of config.stateDir.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) return empty;
    }
    const file = path.join(config.stateDir, 'webcodex.sqlite'), info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return empty;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
      if (config.device && db.prepare("SELECT 1 FROM sqlite_master WHERE name='webcodex_state_identity'").get()) {
        const identity = db.prepare('SELECT device_id FROM webcodex_state_identity WHERE singleton=1').get();
        if (identity?.device_id !== config.device.id) return { ...empty, reason: 'STATE_DEVICE_MISMATCH' };
      }
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='webcodex_jobs'").get()) return empty;
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='webcodex_workspace_bindings'").get()) return empty;
      const allowed = new Map<string, string>();
      for (const workspace of config.workspaces) {
        const inspected = inspectWorkspace(config, workspace);
        if (!inspected.health.available || !inspected.root) continue;
        const root = process.platform === 'win32' ? inspected.root.toLowerCase() : inspected.root;
        const binding = workspace.uid ? db.prepare('SELECT * FROM webcodex_workspace_bindings WHERE workspace_uid=?').get(workspace.uid)
          : db.prepare("SELECT * FROM webcodex_workspace_bindings WHERE canonical_root=? AND registration_kind='v1' LIMIT 1").get(root);
        if (binding?.canonical_root === root && binding.root_fingerprint === inspected.fingerprint) allowed.set(workspace.id, String(binding.binding_id));
      }
      const rows = db.prepare('SELECT job_id,workspace_id,workspace_binding,executable_alias,status,created_at,started_at,ended_at,exit_code,output_bytes,output_truncated FROM webcodex_jobs ORDER BY created_at DESC LIMIT 100').all()
        .filter(r => allowed.has(String(r.workspace_id)) && allowed.get(String(r.workspace_id)) === r.workspace_binding);
      if (jobId) {
        const job = rows.find(row => row.job_id === jobId);
        if (!job) return { ...empty, reason: 'JOB_NOT_FOUND' };
        // Preserve raw chunk boundaries while redacting, including the start/end
        // clipping boundary. Never insert presentation labels inside a secret.
        const chunks = db.prepare('SELECT substr(text,1,32768) AS text,length(text) AS original_length FROM webcodex_job_chunks WHERE job_id=? ORDER BY start_cursor ASC LIMIT 16').all(jobId);
        let raw = '';
        for (const chunk of chunks) {
          const remaining = 32768 - raw.length;
          raw += String(chunk.text).slice(0, remaining);
          if (Number(chunk.original_length) >= remaining) break;
        }
        for (const secret of [config.tunnel?.apiKey, config.http.bearerToken, config.actionsProbe?.apiKey]) {
          if (!secret || secret.length < 8) continue;
          raw = raw.split(secret).join('[REDACTED]');
          // A bounded query can end inside a credential. Suppress every matching
          // edge fragment, not just a full credential present in this window.
          for (let size = Math.min(secret.length - 1, raw.length); size > 0; size--) {
            if (raw.endsWith(secret.slice(0, size))) { raw = raw.slice(0, -size) + '[REDACTED]'; break; }
          }
        }
        const text = safeText(raw, 16384);
        return { available: true, read_only: true, recorded_state_only: true, job_id: jobId, text, partial: true,
          notice: 'Bounded initial recorded output; use MCP exec_poll for complete output and current job observation.' };
      }
      return { ...empty, available: true, jobs: rows.map(r => ({
        job_id: safeText(r.job_id, 100), workspace_id: safeText(r.workspace_id, 100), executable_alias: safeText(r.executable_alias, 100),
        status: safeText(r.status, 50), created_at: r.created_at, started_at: r.started_at, ended_at: r.ended_at,
        exit_code: r.exit_code, output_bytes: r.output_bytes, output_truncated: Boolean(r.output_truncated),
      })) };
    } finally { db.close(); }
  } catch { return empty; }
}

/** Open only the containing directory, never a selected executable or shell command. */
export async function revealLocalFile(directory: string) {
  const info = await lstat(directory);
  if (!path.isAbsolute(directory) || !info.isDirectory() || info.isSymbolicLink() || path.relative(directory, await realpath(directory)) !== '') {
    throw new AppError('PATH_DENIED', 'The containing directory is unavailable.');
  }
  let executable: string, args: string[];
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new AppError('REVEAL_UNAVAILABLE', 'File manager is unavailable.');
    executable = path.join(systemRoot, 'explorer.exe'); args = [directory];
  } else if (process.platform === 'darwin') { executable = '/usr/bin/open'; args = ['--', directory]; }
  else if (process.platform === 'linux') { executable = '/usr/bin/xdg-open'; args = [directory]; }
  else throw new AppError('REVEAL_UNAVAILABLE', 'Use the copied path with your file manager.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, detached: false, stdio: 'ignore' });
    child.once('error', () => reject(new AppError('REVEAL_UNAVAILABLE', 'File manager could not be opened.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function body(req: IncomingMessage, limit = BODY_LIMIT): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0, finished = false; const chunks: Buffer[] = [];
    const finish = (error?: AppError) => {
      if (finished) return; finished = true; clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', interrupted); req.off('aborted', interrupted);
      if (error) { req.once('error', () => {}); req.resume(); reject(error); return; }
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value as Record<string, unknown>);
      } catch { reject(new AppError('INVALID_ARGUMENT', 'Expected a JSON object.')); }
    };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > limit) finish(new AppError('REQUEST_TOO_LARGE', 'Request is too large.')); else chunks.push(chunk); };
    const end = () => finish();
    const interrupted = () => finish(new AppError('REQUEST_INTERRUPTED', 'Request was interrupted.'));
    const timer = setTimeout(() => finish(new AppError('REQUEST_TIMEOUT', 'Request timed out.')), 5000);
    req.on('data', data); req.once('end', end); req.once('error', interrupted); req.once('aborted', interrupted);
  });
}

export async function startLocalPanel(inputConfig: AppConfig, options: { port?: number; reveal?: (directory: string) => Promise<void>; management?: { config: PanelConfigService; runtime: PanelRuntime }; onRuntimeAction?: (action: string, status: unknown) => void } = {}) {
  let config = structuredClone(inputConfig);
  let workspaceBindings = new Map(config.workspaces.map(workspace => [workspace.id, inspectWorkspace(config, workspace).fingerprint ?? null]));
  bindWorkspaceRuntime(config, workspaceBindings);
  let paths = new WorkspacePaths(config);
  const token = randomBytes(32).toString('base64url'), expectedAuth = Buffer.from('Bearer ' + token);
  const forbiddenStore: Store = {
    get db(): DatabaseSync { throw new AppError('PANEL_READ_ONLY', 'Local panel cannot open a writable state store.'); },
    idempotent: async () => { throw new AppError('PANEL_READ_ONLY', 'Local panel cannot mutate project state.'); },
    audit: () => { /* The read-only viewer must not write into a running daemon's state. */ },
  };
  // Each UI page uses one index snapshot. Active Codex sessions can update the
  // ordering between windows; continue through the existing signed cursor instead
  // of rescanning several changing snapshots inside a single HTTP request.
  let sessionConfig: AppConfig = { ...config, codexSessions: { ...config.codexSessions, maxWindowsPerRequest: 1 } };
  bindWorkspaceRuntime(sessionConfig, workspaceBindings);
  let sessions = new CodexSessionService({ config: sessionConfig, paths, store: forbiddenStore }, async () => { throw new AppError('PANEL_READ_ONLY', 'Use MCP for session handoff.'); });
  const refreshSnapshot = async () => {
    const fresh = await loadPanelViewConfig(inputConfig.configPath);
    const bindings = new Map(fresh.workspaces.map(workspace => [workspace.id, inspectWorkspace(fresh, workspace).fingerprint ?? null]));
    bindWorkspaceRuntime(fresh, bindings);
    config = fresh; workspaceBindings = bindings; paths = new WorkspacePaths(config);
    sessionConfig = { ...config, codexSessions: { ...config.codexSessions, maxWindowsPerRequest: 1 } };
    bindWorkspaceRuntime(sessionConfig, workspaceBindings);
    sessions = new CodexSessionService({ config: sessionConfig, paths, store: forbiddenStore }, async () => { throw new AppError('PANEL_READ_ONLY', 'Use MCP for session handoff.'); });
  };
  let port = options.port ?? config.localPanel?.port ?? 8767;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AppError('CONFIG_ERROR', 'Invalid local panel port.');
  let origin = '', active = 0, closing: Promise<void> | undefined;
  const legacyHtml = renderLocalPanel();
  const html = options.management ? renderLocalAdmin() : legacyHtml;
  // Static asset hashes permit only this bundled code; no inline handlers, external scripts or CDN.
  const inlineHashes = [...(html + legacyHtml).matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(match => `'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`).join(' ');
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'none'; script-src ${inlineHashes}; style-src ${inlineHashes}; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` };
  const send = (res: ServerResponse, status: number, value: unknown, page = false) => {
    if (res.destroyed || res.headersSent) return;
    const text = page ? String(value) : JSON.stringify(value);
    res.writeHead(status, { ...headers, 'Content-Type': page ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text), ...(status >= 400 ? { Connection: 'close' } : {}) }); res.end(text);
  };
  const location = (value: Record<string, unknown>) => {
    if (Object.keys(value).some(key => !['workspace_id', 'path'].includes(key)) || typeof value.workspace_id !== 'string' || typeof value.path !== 'string') {
      throw new AppError('INVALID_ARGUMENT', 'Supply workspace_id and a relative path.');
    }
    return { workspace_id: value.workspace_id, path: value.path };
  };
  async function fileInfo(workspaceId: string, relative: string, config: AppConfig, paths: WorkspacePaths) {
    const absolute = await paths.resolve(workspaceId, relative), before = await lstat(absolute, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new AppError('PATH_DENIED', 'Select an ordinary file.');
    const max = config.limits.fileReadMaxBytes ?? 16777216;
    let sha256: string | null = null;
    if (before.size <= BigInt(max)) {
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if (!same(before, await handle.stat({ bigint: true }))) throw new AppError('FILE_CHANGED', 'The file changed.');
        const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let offset = 0;
        while (offset < Number(before.size)) {
          const result = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
          if (!result.bytesRead) throw new AppError('FILE_CHANGED', 'The file changed.');
          offset += result.bytesRead; hash.update(buffer.subarray(0, result.bytesRead));
        }
        if (!same(before, await handle.stat({ bigint: true }))) throw new AppError('FILE_CHANGED', 'The file changed.');
        sha256 = hash.digest('hex');
      } finally { await handle.close(); }
    }
    await paths.resolve(workspaceId, relative);
    const after = await lstat(absolute, { bigint: true });
    if (!same(before, after) || after.nlink !== 1n || after.isSymbolicLink()) throw new AppError('FILE_CHANGED', 'The file changed.');
    const types: Record<string, string> = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
    return { workspace_id: workspaceId, path: path.relative(paths.get(workspaceId).root, absolute).split(path.sep).join('/'), absolute_path: absolute,
      name: path.basename(absolute), size_bytes: Number(before.size), mime_type: types[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream',
      mime_type_source: 'extension', sha256, hash_status: sha256 === null ? 'not_computed_size_limit' : 'verified', hash_max_bytes: max,
      upload_status: 'not_uploaded', model_access: 'unverified', content_processing: 'none', upload_method: 'chatgpt_native_attachment' };
  }
  const server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    // Keep pre-authentication and request-shape failures diagnosable.  These
    // paths used to return only a code, which made the admin page collapse
    // every rejected save into the vague “本机服务拒绝了此操作” message.
    const fail = (status: number, code: string) => {
      const messages: Record<string, string> = {
        REQUEST_ORIGIN_DENIED: '请求来源与面板地址不一致。请使用启动命令输出的完整回环链接（127.0.0.1 或 localhost）打开面板；通过 SSH 转发时请使用本机转发端口。',
        PANEL_AUTH_REQUIRED: '面板凭据缺失或已失效。请从本机启动命令重新打开带凭据的链接。',
        JSON_REQUIRED: '管理请求必须使用 application/json。请刷新页面后重试。',
        REQUEST_TOO_LARGE: '配置请求过大。请减少一次修改的字段数量。',
        PANEL_CLOSING: '服务正在关闭，请稍候刷新页面。',
        PANEL_BUSY: '本机正在处理另一个请求，请稍后重试。',
      };
      send(res, status, { ok: false, error: { code, message: messages[code] ?? '本机拒绝了该请求。' } });
    };
    // Host and Origin may use equivalent loopback spellings (127.0.0.1 or
    // localhost), especially when a Linux service is reached through SSH
    // local port forwarding.  Never accept a non-loopback authority.
    const hostPort = loopbackAuthorityPort(req.headers.host), originPort = req.headers.origin === undefined ? null : loopbackAuthorityPort(req.headers.origin);
    if (hostPort === null || req.headers.origin !== undefined && (originPort === null || originPort !== hostPort)) { fail(403, 'REQUEST_ORIGIN_DENIED'); return; }
    if (req.url === '/' && req.method === 'GET') { send(res, 200, html, true); return; }
    if (req.url === '/files' && req.method === 'GET' && options.management) { send(res, 200, legacyHtml, true); return; }
    if (req.url === '/favicon.ico' && req.method === 'GET') { res.writeHead(204, headers); res.end(); return; }
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (actual.length !== expectedAuth.length || !timingSafeEqual(actual, expectedAuth)) { fail(401, 'PANEL_AUTH_REQUIRED'); return; }
    if (closing) { fail(503, 'PANEL_CLOSING'); return; }
    if (active >= 4) { fail(429, 'PANEL_BUSY'); return; }
    active++;
    try {
      const url = new URL(req.url ?? '', origin);
      if (!req.url?.startsWith('/') || url.origin !== origin || /%2f|%5c/i.test(url.pathname)) throw new AppError('INVALID_ARGUMENT', 'Invalid request path.');
      const view = { config, paths, sessions };
      const query = () => { const pairs = [...url.searchParams]; if (new Set(pairs.map(([key]) => key)).size !== pairs.length) throw new AppError('INVALID_ARGUMENT', 'Duplicate query fields.'); return Object.fromEntries(pairs); };
      if (options.management && !url.search) {
        const management = options.management;
        if (req.method === 'GET' && url.pathname === '/api/config') { send(res, 200, await management.config.read()); return; }
        if (req.method === 'GET' && url.pathname === '/api/runtime') { send(res, 200, await management.runtime.status()); return; }
        if (req.method === 'POST' && ['/api/config/validate', '/api/config/save', '/api/runtime', '/api/access-check'].includes(url.pathname)) {
          // Administrative writes require an explicit same-origin browser request,
          // in addition to the private per-panel bearer token. No CORS support.
          // The bearer token already authenticates the owner. For SSH -L,
          // reverse forwarding and localhost/127.0.0.1 aliases, the browser's
          // Origin port can legitimately differ from the upstream Host port.
          // Keep both authorities loopback-only, but do not reject a valid
          // authenticated request merely because a forwarding layer rewrote
          // one of the ports. Cross-site fetches remain blocked by requiring a
          // loopback Origin and (when supplied) same-origin fetch metadata.
          if (originPort === null || req.headers['sec-fetch-site'] !== undefined && !['same-origin', 'same-site', 'none'].includes(req.headers['sec-fetch-site'])) { fail(403, 'REQUEST_ORIGIN_DENIED'); return; }
          if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding'] !== undefined) { fail(415, 'JSON_REQUIRED'); return; }
          if (Number(req.headers['content-length'] ?? 0) > ADMIN_BODY_LIMIT) { fail(413, 'REQUEST_TOO_LARGE'); return; }
          const input = await body(req, ADMIN_BODY_LIMIT);
          if (url.pathname === '/api/access-check') {
            if (Object.keys(input).length !== 0) throw new AppError('INVALID_ARGUMENT', 'The local access check accepts no input.');
            const current = await loadConfig(inputConfig.configPath, { workspaceDiagnostics: true });
            send(res, 200, await checkLocalAccess(current)); return;
          }
          if (url.pathname === '/api/runtime') {
            if (Object.keys(input).some(key => !['action','expected_revision'].includes(key)) || !['start','stop','restart'].includes(String(input.action)) || input.expected_revision !== undefined && (typeof input.expected_revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_revision))) throw new AppError('INVALID_ARGUMENT', 'Select a service action and current configuration revision.');
            const result = await management.runtime.action(input as unknown as Parameters<PanelRuntime['action']>[0]);
            try { options.onRuntimeAction?.(String(input.action), result.status); } catch { /* logging cannot affect the action */ }
            send(res, 200, result); return;
          }
          if (url.pathname === '/api/config/validate') { send(res, 200, await management.config.validate(input as Parameters<PanelConfigService['validate']>[0])); return; }
          const result = await management.config.save(input as Parameters<PanelConfigService['save']>[0]);
          // A committed save is not undone when a subsequent local status read fails.
          // Preserve its revision receipt and label the stale viewer explicitly.
          let viewerRefreshed = true;
          try { await refreshSnapshot(); } catch { viewerRefreshed = false; }
          send(res, 200, { ...result, viewer_refreshed: viewerRefreshed }); return;
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/status' && !url.search) {
        const tunnel = await readTunnelStatus(view.config, { timeoutMs: 1500 });
        send(res, 200, { version: VERSION, device: view.config.device ?? { id: null, name: 'Local device' }, config_path: view.config.configPath,
          observed_at: new Date().toISOString(), execution_mode: view.config.execution.mode, settings_snapshot: options.management ? 'saved_local_config_not_running_service' : 'restart_panel_after_config_changes',
          workspaces: view.config.workspaces.map(w => ({ workspace_id: w.id, name: w.name, root: w.root, read_only: w.readOnly, enabled: w.enabled !== false, ...workspaceHealth(view.config, w) })),
          tunnel, jobs: readJobs(view.config), diagnostics: readMcpDiagnostics(view.config, 12),
          codex: { enabled: view.config.codexSessions.enabled, home: view.config.codexSessions.home, read_only: true },
          original_files: { method: 'chatgpt_native_attachment', automatic_upload: false, model_access: 'unverified' } }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/files') {
        const input = location(query());
        const directory = await view.paths.resolve(input.workspace_id, input.path, { directory: true });
        const stream = await opendir(directory); const entries: unknown[] = []; let scanned = 0, truncated = false;
        for await (const item of stream) {
          if (++scanned > 1000 || entries.length >= view.config.limits.listMaxEntries) { truncated = true; break; }
          const rel = path.relative(view.paths.get(input.workspace_id).root, path.join(directory, item.name)).split(path.sep).join('/');
          try {
            const target = await view.paths.resolve(input.workspace_id, rel), info = await lstat(target);
            entries.push({ name: item.name, path: rel, type: info.isDirectory() ? 'directory' : 'file', ...(info.isFile() ? { size_bytes: info.size } : {}) });
          } catch { /* Inaccessible or protected entries are not attachment candidates. */ }
        }
        await view.paths.resolve(input.workspace_id, input.path, { directory: true });
        send(res, 200, { workspace_id: input.workspace_id, path: input.path, entries, truncated, selection_hint: 'Use an exact relative path when a directory listing is truncated.' }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/codex/sessions') {
        const input = query();
        if (Object.keys(input).some(key => !['workspace_id', 'cursor'].includes(key)) || !input.workspace_id) throw new AppError('INVALID_ARGUMENT', 'Select a workspace.');
        try { send(res, 200, await view.sessions.list({ workspace_id: input.workspace_id, cursor: input.cursor, limit: 20 })); }
        catch (error) {
          const code = safeCode(error);
          const changed = code === 'HISTORY_INDEX_CHANGED' || code === 'INVALID_CURSOR';
          send(res, changed ? 409 : 422, { ok: false, error: { code }, recovery: changed ? 'refresh_sessions'
            : ['CODEX_SESSIONS_DISABLED', 'HISTORY_PATH_DENIED', 'NOT_FOUND'].includes(code) ? 'check_codex_config' : 'inspect_local_diagnostics' });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/job-output') {
        const input = query();
        if (Object.keys(input).length !== 1 || !/^[0-9a-f-]{36}$/i.test(input.job_id ?? '')) throw new AppError('INVALID_ARGUMENT', 'Select a job.');
        send(res, 200, readJobs(view.config, input.job_id)); return;
      }
      if (req.method === 'POST' && ['/api/file-info', '/api/reveal'].includes(url.pathname) && !url.search) {
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding'] !== undefined) { fail(415, 'JSON_REQUIRED'); return; }
        if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT) { fail(413, 'REQUEST_TOO_LARGE'); return; }
        const input = location(await body(req));
        const info = await fileInfo(input.workspace_id, input.path, view.config, view.paths);
        if (url.pathname === '/api/file-info') { send(res, 200, info); return; }
        await view.paths.resolve(input.workspace_id, input.path);
        await (options.reveal ?? revealLocalFile)(path.dirname(info.absolute_path));
        send(res, 200, { ok: true, action: 'file_manager_requested', upload_status: 'not_uploaded' }); return;
      }
      fail(404, 'NOT_FOUND');
    } catch (error) {
      const code = safeCode(error);
      const status = code === 'REQUEST_TOO_LARGE' ? 413 : code === 'REQUEST_TIMEOUT' ? 408 : code === 'INVALID_ARGUMENT' ? 400 : ['CONFIG_CONFLICT','CONFIG_LOCKED','CONFIG_EDIT_BUSY','PANEL_RUNTIME_BUSY','PANEL_JOBS_ACTIVE'].includes(code) ? 409 : 422;
      const details = error instanceof AppError ? safePanelDetails(error.details) : undefined;
      send(res, status, { ok: false, error: { code, ...details } });
    }
    finally { active--; }
  });
  server.headersTimeout = 10000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    const error = (failure: NodeJS.ErrnoException) => reject(new AppError('PANEL_START_FAILED', 'The local panel port is unavailable.', {
      reason: failure.code === 'EADDRINUSE' ? 'address_in_use' : 'listen_failed',
    }));
    server.once('error', error); server.listen(port, '127.0.0.1', () => { server.off('error', error); resolve(); });
  });
  port = (server.address() as { port: number }).port; origin = 'http://127.0.0.1:' + port;
  return { url: origin + '/#token=' + token, close: () => closing ??= new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => server.closeAllConnections(), 1000); timer.unref();
    server.close(error => { clearTimeout(timer); if (error) reject(new AppError('PANEL_CLOSE_FAILED', 'Panel could not close.')); else resolve(); }); server.closeIdleConnections();
  }) };
}
