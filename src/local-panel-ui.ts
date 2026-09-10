/** Static local UI. Credentials and all machine-specific values arrive at runtime. */
export function renderLocalPanel(): string {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>WebCodex · 本地控制面板</title>
<style>
:root{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#20312e;background:#f3f5f4;font-size:14px;line-height:1.6}
*{box-sizing:border-box}body{margin:0}button,input,select,textarea{font:inherit}button,select{cursor:pointer}button{border:1px solid #cdd7d2;border-radius:8px;background:#fff;color:#20312e;padding:7px 13px;line-height:1.5}button:hover:not(:disabled){background:#edf4f0;border-color:#7b9d8d}button:disabled,select:disabled{cursor:default;opacity:.5}button.primary{background:#206848;border-color:#206848;color:white}button.primary:hover:not(:disabled){background:#185338}button.link{border:0;padding:0;color:#1b654b;background:none;text-align:left;overflow-wrap:anywhere}button.link:hover:not(:disabled){background:none;text-decoration:underline}a{color:#246b51}input,select,textarea{border:1px solid #cdd7d2;border-radius:7px;background:white;color:inherit;padding:7px 9px;max-width:100%}input:focus-visible,select:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid #a0c9b6;outline-offset:2px}textarea{resize:vertical;width:100%}[hidden]{display:none!important}
.shell{max-width:1240px;margin:auto;padding:28px 28px 42px}.header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:20px}.brand{display:flex;align-items:center;gap:12px}.mark{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:#206848;color:white;font-size:19px;font-weight:700}.eyebrow{font-size:12px;letter-spacing:.12em;color:#5c7367}.header h1{font-size:23px;margin:0;line-height:1.4}.header p{color:#62746c;margin:4px 0 0;font-size:13px}.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.badge{display:inline-block;border-radius:20px;padding:3px 10px;background:#e9efec;color:#465e52;font-size:12px;white-space:nowrap}.badge[data-state="ok"]{background:#dff0e6;color:#175a3b}.badge[data-state="error"]{background:#fce8e5;color:#94392f}.notice{border:1px solid #d5e2db;background:#edf5f0;padding:12px 15px;border-radius:10px;margin-bottom:18px;color:#405c4b}.notice[data-state="error"]{border-color:#efcfc8;background:#fff1ee;color:#873f35}.muted{color:#6b7b73;font-size:13px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{border:1px solid #dce3df;border-radius:12px;background:white;overflow:hidden;margin-bottom:18px}.grid>.card{margin-bottom:0}.card-head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid #e8edea;gap:14px}.card-head h2{font-size:16px;margin:0}.card-head p{margin:2px 0 0}.card-body{padding:16px 18px}.section-gap{margin-top:18px}.facts{display:grid;grid-template-columns:95px minmax(0,1fr);gap:7px 15px;margin:0}.facts dt{color:#6b7b73}.facts dd{margin:0;overflow-wrap:anywhere}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}th{color:#6b7b73;font-weight:500;white-space:nowrap;background:#fafcfb}th,td{padding:10px 13px;border-bottom:1px solid #edf0ee;vertical-align:top}tbody tr:last-child td{border-bottom:0}td{overflow-wrap:anywhere}td small{display:block;color:#76847c;margin-top:3px}.empty{padding:24px 16px;text-align:center;color:#7a877f}.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 18px;background:#fafcfb;border-bottom:1px solid #e8edea}.toolbar label{font-size:13px;color:#5c6f64}.toolbar select{min-width:170px;max-width:340px}.path-form{display:flex;align-items:center;gap:8px;flex:1;min-width:200px}.path-form input{flex:1;min-width:100px}.file-layout{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,1fr)}.file-list{min-height:250px;max-height:430px;overflow:auto}.file-detail{background:#fbfcfb;border-left:1px solid #e6ebe8;padding:17px 18px}.file-detail h3{font-size:14px;margin:0 0 12px}.file-detail .facts{grid-template-columns:64px minmax(0,1fr);font-size:12px}.field-label{display:block;color:#6b7b73;font-size:12px;margin:14px 0 5px}.attachment-note{font-size:12px;color:#50695a;border-top:1px solid #e1e8e3;margin-top:16px;padding-top:13px}.footnote{margin:10px 0 0;font-size:12px;color:#7a867f}.feedback{min-height:22px;font-size:12px;color:#41604e;margin:9px 0 0}.feedback[data-state="error"]{color:#984639}.footer{margin-top:20px;color:#79877e;font-size:12px}.pill-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:13px}.session-list{list-style:none;padding:0;margin:0}.session-list li{padding:11px 18px;border-bottom:1px solid #edf0ee}.session-list li:last-child{border-bottom:0}.session-title{font-weight:500;overflow-wrap:anywhere}.session-meta{font-size:12px;color:#758279;overflow-wrap:anywhere}.tight{margin:0}.current-row{background:#f0f7f2}.log-output{white-space:pre-wrap;max-height:240px;overflow:auto}code{font-size:12px}
@media(max-width:850px){.grid{grid-template-columns:1fr}.file-layout{grid-template-columns:1fr}.file-detail{border-left:0;border-top:1px solid #e6ebe8}.shell{padding:20px 16px}.header{flex-wrap:wrap}.path-form{flex-basis:100%}.facts{grid-template-columns:84px minmax(0,1fr)}}
</style>
</head>
<body>
<main class="shell">
  <header class="header">
    <div class="brand"><div class="mark" aria-hidden="true">W</div><div><div class="eyebrow">WEBCODEX / LOCAL</div><h1>本地控制面板</h1><p>查看连接、工作区与任务，找到需要交给 ChatGPT 的原文件。</p></div></div>
    <div class="actions"><span class="badge">只读查看</span><span id="connection" class="badge" aria-live="polite">等待连接</span><button id="refresh" class="primary" type="button">刷新状态</button></div>
  </header>
  <div id="notice" class="notice" role="status" aria-live="polite">正在连接本机服务…</div>
  <div class="grid">
    <section class="card" aria-labelledby="device-heading"><div class="card-head"><h2 id="device-heading">当前设备</h2><span id="version" class="badge">版本 —</span></div><div class="card-body"><dl class="facts"><dt>设备名称</dt><dd id="device-name">—</dd><dt>设备 ID</dt><dd id="device-id" class="mono">—</dd><dt>执行权限</dt><dd id="execution-mode">—</dd><dt>配置文件</dt><dd id="config-path" class="mono">—</dd></dl><p class="footnote">这里只显示配置路径与运行状态。修改配置请在本机编辑配置文件。</p></div></section>
    <section class="card" aria-labelledby="tunnel-heading"><div class="card-head"><h2 id="tunnel-heading">官方 MCP 隧道</h2><span id="tunnel-health" class="badge">尚未检查</span></div><div class="card-body"><dl class="facts"><dt>启动阶段</dt><dd id="tunnel-phase">—</dd><dt>健康状态</dt><dd id="tunnel-state">—</dd><dt>工具调用</dt><dd id="tunnel-calls">—</dd></dl><p id="tunnel-note" class="footnote">隧道连通与文件被模型读取是不同状态，请以实际调用结果为准。</p></div></section>
  </div>
  <section class="card section-gap" aria-labelledby="workspace-heading"><div class="card-head"><div><h2 id="workspace-heading">工作区</h2><p class="muted">以设备 ID 和工作区 ID 区分不同目录，权限以本机配置为准。</p></div><span id="workspace-count" class="badge">0 个</span></div><div class="table-wrap"><table><thead><tr><th>名称 / ID</th><th>本机目录</th><th>权限</th><th>目录健康</th></tr></thead><tbody id="workspace-rows"></tbody></table></div><p id="workspace-empty" class="empty">等待工作区信息</p></section>
  <section class="card" aria-labelledby="files-heading"><div class="card-head"><div><h2 id="files-heading">原文件浏览</h2><p class="muted">浏览文件信息、复制完整路径，或打开文件所在目录。</p></div><button id="files-refresh" type="button" disabled>刷新目录</button></div>
    <div class="toolbar"><label for="workspace">工作区</label><select id="workspace" disabled aria-label="选择工作区"></select><form id="path-form" class="path-form"><button id="parent" type="button" disabled>上一级</button><input id="directory" value="" placeholder="工作区内的相对路径，留空为根目录" aria-label="工作区内的相对路径" autocomplete="off" spellcheck="false" disabled><button id="browse" type="submit" disabled>打开目录</button><button id="inspect-path" type="button" disabled>查看文件</button></form></div>
    <div class="file-layout"><div><div class="file-list"><table><thead><tr><th>名称</th><th>类型</th><th>大小</th></tr></thead><tbody id="file-rows"></tbody></table><p id="file-empty" class="empty">选择一个可用工作区后浏览文件</p></div><p id="files-feedback" class="feedback card-body" aria-live="polite"></p></div>
      <aside class="file-detail"><h3 id="file-name">文件信息</h3><p id="file-placeholder" class="muted">选择文件后查看元信息。</p><div id="file-info" hidden><dl class="facts"><dt>大小</dt><dd id="file-size">—</dd><dt>格式</dt><dd id="file-mime">—</dd><dt>SHA-256</dt><dd id="file-hash" class="mono">—</dd></dl><label class="field-label" for="file-absolute">完整路径</label><textarea id="file-absolute" class="mono" rows="3" readonly spellcheck="false"></textarea><div class="actions section-gap"><button id="copy-path" type="button" disabled>复制完整路径</button><button id="reveal" type="button" disabled>打开所在目录</button></div></div><p id="file-feedback" class="feedback" aria-live="polite"></p><div class="attachment-note">在 ChatGPT 网页点击附件按钮，选择本机原文件。可将完整路径粘贴到系统文件选择框，或从打开的目录找到文件。<br>此面板只帮助定位文件，不会自动上传；文件是否可读以 ChatGPT 实际读取结果为准。</div></aside></div>
  </section>
  <div class="grid">
    <section class="card" aria-labelledby="jobs-heading"><div class="card-head"><div><h2 id="jobs-heading">作业</h2><p class="muted">仅显示已记录的状态，不保证历史进程仍在运行。</p></div><span id="job-count" class="badge">0 项</span></div><div class="table-wrap"><table><thead><tr><th>作业 / 程序</th><th>工作区</th><th>记录状态</th><th>退出码</th></tr></thead><tbody id="job-rows"></tbody></table></div><p id="job-empty" class="empty">暂无作业信息</p><div id="job-output-box" class="card-body" hidden><p id="job-output-title" class="muted tight"></p><pre id="job-output" class="mono log-output"></pre></div><p id="job-feedback" class="feedback card-body" aria-live="polite"></p></section>
    <section class="card" aria-labelledby="codex-heading"><div class="card-head"><div><h2 id="codex-heading">Codex 会话</h2><p class="muted">当前工作区的本地会话索引，只读查看。</p></div><div class="actions"><button id="sessions-refresh" type="button" disabled>刷新列表</button><button id="sessions-next" type="button" hidden disabled>下一页</button></div></div><ul id="session-rows" class="session-list"></ul><p id="session-empty" class="empty">等待会话索引</p><div id="handoff-preview" class="card-body" hidden><label for="handoff-request" class="field-label">粘贴到已连接 WebCodex 的 ChatGPT 对话</label><textarea id="handoff-request" rows="5" readonly></textarea></div><p id="session-feedback" class="feedback card-body" aria-live="polite"></p></section>
  </div>
  <section class="card section-gap" aria-labelledby="diagnostics-heading"><div class="card-head"><div><h2 id="diagnostics-heading">诊断摘要</h2><p class="muted">仅显示协议状态与错误代码。响应已发送不代表 ChatGPT 已使用结果。</p></div><span id="diagnostics-state" class="badge">尚未检查</span></div><div class="table-wrap"><table><thead><tr><th>时间</th><th>方法 / 工具</th><th>结果</th><th>阶段 / 错误代码</th></tr></thead><tbody id="diagnostic-rows"></tbody></table></div><p id="diagnostic-empty" class="empty">暂无诊断记录</p></section>
  <footer class="footer">此页面只连接当前本机服务。<span id="updated">尚未刷新</span></footer>
</main>
<script>
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const storageKey = 'webcodex.local-panel.token.v1';
  const state = { token: '', deviceId: '', workspace: '', path: '', file: null, statusRevision: 0, filesRevision: 0, infoRevision: 0, sessionsRevision: 0, jobRevision: 0, codexEnabled: false, nextSessionCursor: '' };
  const text = (value, fallback = '—') => typeof value === 'string' && value.length ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback;
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const list = value => Array.isArray(value) ? value : [];
  const put = (id, value) => { $(id).textContent = text(value); };
  const make = (tag, value, className) => { const result = document.createElement(tag); if (value !== undefined) result.textContent = text(value, ''); if (className) result.className = className; return result; };
  const message = (id, value, error = false) => { put(id, value); $(id).dataset.state = error ? 'error' : 'ok'; };
  const clear = id => $(id).replaceChildren();
  const issue = (message, code) => Object.assign(new Error(message), { panelMessage: true, code });
  const explain = error => error && error.panelMessage === true ? error.message : '无法连接本机服务。请确认服务仍在运行，然后重试。';
  const bytes = value => {
    if (!Number.isSafeInteger(value) || value < 0) return '—';
    if (value < 1024) return value + ' B';
    const unit = value >= 1073741824 ? 1073741824 : value >= 1048576 ? 1048576 : 1024;
    return (value / unit).toFixed(1) + (unit === 1073741824 ? ' GiB' : unit === 1048576 ? ' MiB' : ' KiB');
  };
  const labels = { available: '可用', disabled: '已禁用', missing: '目录不存在', inaccessible: '无法访问', blocked: '访问受限', identity_mismatch: '目录身份变化', restart_required: '需要重启服务', queued: '排队中', running: '运行中', succeeded: '已成功', completed: '已完成', failed: '失败', cancelled: '已取消', timed_out: '已超时', unknown: '状态未知', checking: '检查配置', doctor: '检查客户端', starting: '正在启动', validated: '本机配置已验证', stopped: '已停止', connected_waiting_calls: '已连接，等待工具调用', connected_tools_called: '已连接，已完成工具调用', connected: '已连接', poll_not_fresh: '等待有效轮询', mcp_not_ready: '本机 MCP 尚未就绪', authentication_or_permission: '身份验证或权限失败', network_timeout: '网络超时', local_unhealthy: '本机健康检查未通过', diagnostics_unavailable: '诊断暂不可用', not_running: '未运行', received: '已接收', responded: '已响应', rejected: '已拒绝', unconfirmed: '结果未确认', response_sent: '响应已发送' };
  const label = value => Object.hasOwn(labels, value) ? labels[value] : text(value);
  const cells = (target, values) => { const row = make('tr'); for (const value of values) { const cell = make('td'); if (value && typeof value === 'object') cell.append(value); else cell.textContent = text(value); row.append(cell); } $(target).append(row); return row; };
  const titleCell = (title, detail) => { const node = make('div', title); if (detail) node.append(make('small', detail, 'mono')); return node; };
  function forgetToken() {
    state.token = ''; try { sessionStorage.removeItem(storageKey); } catch {}
    state.file = null; $('copy-path').disabled = true; $('reveal').disabled = true;
    message('connection', '需要重新连接', true);
    message('notice', '本地面板凭据已失效。请通过本机启动命令重新打开面板链接。', true);
  }
  async function api(route, body) {
    if (!state.token) throw issue('请通过本机启动命令打开带临时凭据的面板链接。');
    const url = new URL(route, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.username || url.password || url.hash) throw issue('请求地址不属于当前本机面板。');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url.href, { method: body === undefined ? 'GET' : 'POST', mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + state.token, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.status === 401) { forgetToken(); throw issue('本地面板凭据已失效，请从本机重新打开面板。'); }
      if (!response.ok) {
        if (url.pathname === '/api/codex/sessions') {
          const known = { HISTORY_INDEX_CHANGED: 'Codex 会话索引在扫描期间发生更新。请点击“刷新列表”，从第一页重新加载。',
            INVALID_CURSOR: '会话分页已失效，可能是服务重启或索引发生变化。请点击“刷新列表”，从第一页重新加载。',
            CODEX_SESSIONS_DISABLED: '本机未启用 Codex 会话读取，请检查本机配置并重启面板。',
            HISTORY_PATH_DENIED: '本机配置的 Codex 会话目录不可读取，请在本机检查目录与访问权限。',
            NOT_FOUND: '本机配置的 Codex 会话目录已不存在，请在本机检查配置路径。',
            HISTORY_SCAN_LIMIT: '本次会话索引扫描达到本机预算，请在本机检查索引规模与扫描配置。',
            PANEL_BUSY: '本机面板正在处理其他请求，请稍后重新刷新列表。' };
          let code; try { code = object(object(await response.json()).error).code; } catch {}
          if (typeof code === 'string' && Object.hasOwn(known, code)) throw issue(known[code], code);
        }
        throw issue(response.status === 403 ? '本机访问策略拒绝了此操作，请检查工作区权限。' : response.status === 404 ? '目标已不存在，请刷新目录后重试。' : '本机服务暂时无法完成操作，请重试。');
      }
      const result = await response.json();
      if (!state.token) throw issue('本地面板凭据已失效，请从本机重新打开面板。');
      if (object(result).ok === false) throw issue('本机服务未完成操作，请刷新状态后重试。');
      return object(result);
    } catch (error) {
      if (controller.signal.aborted) throw issue('请求超时，请确认本机服务状态后重试。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function resetFile() {
    state.infoRevision++; state.file = null; $('file-info').hidden = true; $('file-placeholder').hidden = false;
    $('copy-path').disabled = true; $('reveal').disabled = true; $('file-absolute').value = '';
    put('file-name', '文件信息'); put('file-feedback', '');
  }
  function renderWorkspaces(workspaces) {
    clear('workspace-rows'); clear('workspace');
    const rows = list(workspaces).slice(0, 500);
    let chosen = '';
    for (const entry of rows) {
      const workspace = object(entry); const id = text(workspace.workspace_id ?? workspace.id, ''); if (!id) continue;
      const health = object(workspace.health); const healthState = health.status ?? workspace.status ?? (workspace.enabled === false ? 'disabled' : undefined);
      const permitted = workspace.enabled !== false && health.available !== false && !['disabled','missing','inaccessible','blocked','identity_mismatch','restart_required'].includes(healthState);
      const readOnly = workspace.read_only ?? workspace.readOnly;
      const permission = readOnly === true ? '只读' : readOnly === false ? '读写' : '权限未知';
      cells('workspace-rows', [titleCell(text(workspace.name, id), id + (workspace.uid ? ' · ' + text(workspace.uid) : '')), text(workspace.root), permission, label(healthState)]);
      const option = make('option', text(workspace.name, id) + ' · ' + id + (permitted ? '' : '（不可用）')); option.value = id; option.disabled = !permitted; $('workspace').append(option);
      if (permitted && (!chosen || id === state.workspace)) chosen = id;
    }
    put('workspace-count', rows.length + ' 个'); $('workspace-empty').hidden = rows.length > 0;
    if (!rows.length) put('workspace-empty', '配置中还没有工作区。请在本机配置文件添加目录。');
    $('workspace').value = chosen; $('workspace').disabled = !chosen;
    for (const id of ['files-refresh','directory','browse','inspect-path','parent']) $(id).disabled = !chosen;
    return chosen;
  }
  function renderJobs(value) {
    clear('job-rows'); state.jobRevision++; $('job-output-box').hidden = true; put('job-output', ''); message('job-feedback', ''); const jobs = list(Array.isArray(value) ? value : object(value).jobs).slice(0, 200);
    for (const entry of jobs) {
      const job = object(entry); const id = text(job.job_id ?? job.id, ''); const title = titleCell(text(job.executable_alias ?? job.name, '作业'), id);
      if (id) { const button = make('button', '查看输出', 'link'); button.type = 'button'; button.addEventListener('click', () => loadJobOutput(id)); title.append(button); }
      cells('job-rows', [title, text(job.workspace_id), label(job.status), job.exit_code === null || job.exit_code === undefined ? '—' : job.exit_code]);
    }
    put('job-count', jobs.length + ' 项'); $('job-empty').hidden = jobs.length > 0;
  }
  async function loadJobOutput(jobId) {
    const revision = ++state.jobRevision; $('job-output-box').hidden = true; put('job-output', ''); message('job-feedback', '正在读取已记录输出…');
    try {
      const result = await api('/api/job-output?' + new URLSearchParams({ job_id: jobId }).toString()); if (revision !== state.jobRevision) return;
      if (result.job_id !== jobId) throw issue('返回的作业身份不匹配，请刷新状态。');
      if (result.available !== true) { message('job-feedback', '此作业暂无可读取的已记录输出。'); return; }
      put('job-output-title', '作业 ' + jobId); put('job-output', text(result.text, '（没有输出内容）')); $('job-output-box').hidden = false;
      message('job-feedback', '只显示已记录输出的开头部分；完整输出和当前作业状态请通过 MCP 查询。');
    } catch (error) { if (revision === state.jobRevision) message('job-feedback', explain(error), true); }
  }
  function renderDiagnostics(value) {
    const diagnostics = object(value); const records = list(diagnostics.recent ?? diagnostics.events).slice(0, 100); clear('diagnostic-rows');
    message('diagnostics-state', diagnostics.enabled === false ? '已禁用' : diagnostics.available === true ? '可用' : '暂无可用状态', diagnostics.enabled !== false && diagnostics.available === false);
    for (const entry of records) { const event = object(entry); cells('diagnostic-rows', [text(event.started_at ?? event.timestamp), titleCell(text(event.method), text(event.tool, '')), label(event.outcome), titleCell(label(event.stage), text(event.error_code, ''))]); }
    $('diagnostic-empty').hidden = records.length > 0;
  }
  async function refreshStatus() {
    const revision = ++state.statusRevision; $('refresh').disabled = true; message('connection', '正在刷新');
    try {
      const result = await api('/api/status'); if (revision !== state.statusRevision) return;
      const device = object(result.device); state.deviceId = text(device.id ?? device.device_id, ''); put('device-name', device.name ?? device.device_name); put('device-id', state.deviceId); put('version', '版本 ' + text(result.version));
      put('execution-mode', result.execution_mode === 'disabled' ? '命令执行已禁用' : result.execution_mode === 'trusted-host' ? '允许按工作区策略执行命令' : '状态未知'); put('config-path', result.config_path);
      const tunnel = object(result.tunnel); const health = object(tunnel.health); const stateValue = health.state ?? tunnel.state; const connected = health.connected ?? tunnel.connected;
      put('tunnel-phase', tunnel.phase ? label(tunnel.phase) : connected === true ? '连接已建立' : tunnel.live === true ? '进程已启动，等待连接' : '当前没有已验证的启动进程'); put('tunnel-state', label(stateValue)); put('tunnel-calls', health.successful_tool_calls ?? tunnel.successful_tool_calls);
      message('tunnel-health', connected === true ? '连接已验证' : connected === false ? '尚未连通' : '状态待验证', connected === false);
      put('tunnel-note', '本机 MCP：' + (tunnel.mcp_ready === true ? '已就绪' : tunnel.mcp_ready === false ? '尚未就绪' : '未验证') + '；OpenAI 轮询：' + (tunnel.poll_fresh === true ? '有效' : tunnel.poll_fresh === false ? '未更新' : '未验证') + '。隧道连通不代表文件已被模型读取。');
      renderJobs(result.jobs); renderDiagnostics(result.diagnostics);
      const codex = object(result.codex); state.codexEnabled = codex.enabled === true; $('sessions-refresh').disabled = !state.codexEnabled;
      const selected = renderWorkspaces(result.workspaces); const changed = selected !== state.workspace; state.workspace = selected;
      message('connection', '本机已连接'); message('notice', '已连接当前设备。页面默认只读，打开所在目录只会调用本机文件管理器。'); put('updated', '最后刷新：' + new Date().toLocaleTimeString());
      if (changed) { state.path = ''; $('directory').value = ''; resetFile(); }
      if (selected) await Promise.all([loadFiles(changed ? '' : state.path), loadSessions()]);
      else { state.filesRevision++; state.sessionsRevision++; resetFile(); clear('file-rows'); clear('session-rows'); $('file-empty').hidden = false; $('session-empty').hidden = false; put('file-empty', '没有可浏览的工作区，请检查目录配置与健康状态。'); put('session-empty', '选择一个可用工作区后查看会话。'); }
    } catch (error) { if (revision === state.statusRevision) { message('connection', '连接失败', true); message('notice', explain(error), true); } }
    finally { if (revision === state.statusRevision) $('refresh').disabled = false; }
  }
  async function loadFiles(relativePath) {
    if (!state.workspace) return;
    const workspace = state.workspace; const revision = ++state.filesRevision; resetFile(); clear('file-rows'); $('file-empty').hidden = false; put('file-empty', '正在读取目录…'); message('files-feedback', '');
    try {
      const query = new URLSearchParams({ workspace_id: workspace, path: relativePath });
      const result = await api('/api/files?' + query.toString()); if (revision !== state.filesRevision || workspace !== state.workspace) return;
      if (result.workspace_id !== undefined && result.workspace_id !== workspace) throw issue('返回的工作区身份不匹配，请刷新状态。');
      state.path = text(result.path, relativePath); $('directory').value = state.path; $('parent').disabled = !state.path || state.path === '.';
      const entries = list(result.entries).slice(0, 1000);
      for (const entry of entries) {
        const file = object(entry); const relative = text(file.path, ''); if (!relative) continue;
        const directory = file.type === 'directory'; const regular = file.type === 'file';
        const button = make('button', text(file.name, relative), 'link'); button.type = 'button'; button.disabled = !directory && !regular;
        button.addEventListener('click', () => directory ? loadFiles(relative) : selectFile(workspace, relative));
        cells('file-rows', [button, directory ? '目录' : regular ? '文件' : '其他（不可打开）', directory ? '—' : bytes(file.size_bytes)]);
      }
      $('file-empty').hidden = entries.length > 0; if (!entries.length) put('file-empty', '此目录为空，或没有可显示的条目。');
      message('files-feedback', result.truncated === true || entries.length >= 1000 ? '当前只显示部分条目。请进入更具体的目录。' : entries.length + ' 个条目');
    } catch (error) { if (revision === state.filesRevision) { put('file-empty', '目录读取失败，可以修改相对路径或重试。'); message('files-feedback', explain(error), true); } }
  }
  async function selectFile(workspace, relativePath) {
    resetFile(); const revision = state.infoRevision; message('file-feedback', '正在读取文件元信息…');
    try {
      const file = await api('/api/file-info', { workspace_id: workspace, path: relativePath });
      if (revision !== state.infoRevision || workspace !== state.workspace) return;
      if (file.path !== relativePath || typeof file.absolute_path !== 'string' || !file.absolute_path || (file.workspace_id !== undefined && file.workspace_id !== workspace)) throw issue('文件身份信息不匹配，请刷新目录后重试。');
      state.file = { workspace_id: workspace, path: relativePath, absolute_path: file.absolute_path };
      put('file-name', text(file.name, relativePath)); put('file-size', bytes(file.size_bytes)); put('file-mime', file.mime_type); put('file-hash', file.hash_status === 'not_computed_size_limit' ? '超过本机哈希计算预算，未计算；仍可使用原生附件选择此文件。' : file.sha256);
      $('file-absolute').value = file.absolute_path; $('file-info').hidden = false; $('file-placeholder').hidden = true; $('copy-path').disabled = false; $('reveal').disabled = false;
      message('file-feedback', '已取得文件信息；尚未上传到 ChatGPT。');
    } catch (error) { if (revision === state.infoRevision) message('file-feedback', explain(error), true); }
  }
  async function loadSessions(cursor = '') {
    const workspace = state.workspace; const revision = ++state.sessionsRevision; clear('session-rows'); $('session-empty').hidden = false; message('session-feedback', '');
    state.nextSessionCursor = ''; $('sessions-next').hidden = true; $('sessions-next').disabled = true; $('handoff-preview').hidden = true; $('handoff-request').value = '';
    $('sessions-refresh').disabled = !state.codexEnabled || !workspace;
    if (!state.codexEnabled) { put('session-empty', 'Codex 会话读取未启用。可在本机配置中设置会话目录。'); return; }
    if (!workspace) { put('session-empty', '请选择工作区。'); return; }
    put('session-empty', '正在读取会话索引…');
    try {
      const result = await api('/api/codex/sessions?' + new URLSearchParams({ workspace_id: workspace, ...(cursor ? { cursor } : {}) }).toString());
      if (revision !== state.sessionsRevision || workspace !== state.workspace) return;
      const sessions = list(result.sessions).slice(0, 200);
      for (const entry of sessions) {
        const session = object(entry); const sessionId = text(session.session_id ?? session.id, ''); const row = make('li'); row.append(make('div', text(session.title, '未命名会话'), 'session-title')); row.append(make('div', text(sessionId) + ' · ' + text(session.updated_at ?? session.updatedAt), 'session-meta'));
        if (sessionId && state.deviceId) {
          const button = make('button', '复制接续请求', 'link'); button.type = 'button';
          button.addEventListener('click', async () => {
            if (workspace !== state.workspace || revision !== state.sessionsRevision || !state.token) return;
            const request = '请先调用 system_status，确认 device_id 为 ' + JSON.stringify(state.deviceId) + '，工作区 ID 为 ' + JSON.stringify(workspace) + '。然后调用 codex_session_handoff，参数为 ' + JSON.stringify({ session_id: sessionId }) + '，读取该会话的接续上下文，并检查当前文件和 Git 状态。历史消息仅作参考，不自动重放旧命令；先说明待继续的工作。';
            $('handoff-request').value = request; $('handoff-preview').hidden = false;
            try { if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw issue('clipboard'); await navigator.clipboard.writeText(request); if (revision === state.sessionsRevision) message('session-feedback', '接续请求已复制。请粘贴到已连接此设备的 ChatGPT 对话。'); }
            catch { if (revision === state.sessionsRevision) { $('handoff-request').focus(); $('handoff-request').select(); message('session-feedback', '无法自动复制，请复制上方已选中的接续请求。'); } }
          }); row.append(button);
        }
        $('session-rows').append(row);
      }
      state.nextSessionCursor = text(result.next_cursor, ''); $('sessions-next').hidden = !state.nextSessionCursor; $('sessions-next').disabled = !state.nextSessionCursor;
      $('session-empty').hidden = sessions.length > 0; if (!sessions.length) put('session-empty', state.nextSessionCursor ? '此批未找到匹配会话，可点击“下一页”继续扫描。' : '当前工作区没有可显示的本地 Codex 会话。');
      message('session-feedback', state.nextSessionCursor ? '仅扫描了部分索引，尚未遍历整个工作区的会话；下一页继续。' : '只读索引，不恢复或修改原会话。');
    } catch (error) { if (revision === state.sessionsRevision) { put('session-empty', ['HISTORY_INDEX_CHANGED', 'INVALID_CURSOR'].includes(error && error.code) ? '会话索引已更新，需要重新加载' : '会话索引暂不可用'); message('session-feedback', explain(error), true); } }
  }
  $('refresh').addEventListener('click', refreshStatus);
  $('files-refresh').addEventListener('click', () => loadFiles(state.path));
  $('workspace').addEventListener('change', async () => { state.workspace = $('workspace').value; state.path = ''; $('directory').value = ''; resetFile(); await Promise.all([loadFiles(''), loadSessions()]); });
  $('path-form').addEventListener('submit', event => { event.preventDefault(); return loadFiles($('directory').value); });
  $('inspect-path').addEventListener('click', () => {
    const relative = $('directory').value.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (!state.workspace || !relative || relative.startsWith('/') || /^[A-Za-z]:/.test(relative) || relative.split('/').includes('..')) { message('file-feedback', '请填写工作区内文件的相对路径，例如 论文/报告.pdf。', true); return; }
    return selectFile(state.workspace, relative);
  });
  $('parent').addEventListener('click', () => { const parts = state.path.replace(/\\/g, '/').split('/').filter(Boolean); parts.pop(); return loadFiles(parts.join('/')); });
  $('sessions-refresh').addEventListener('click', () => loadSessions());
  $('sessions-next').addEventListener('click', () => loadSessions(state.nextSessionCursor));
  $('copy-path').addEventListener('click', async () => {
    const file = state.file; if (!file) return;
    try { if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw issue('clipboard'); await navigator.clipboard.writeText(file.absolute_path); if (state.file === file) message('file-feedback', '完整路径已复制。请在 ChatGPT 的文件选择框中粘贴。'); }
    catch { if (state.file === file) { $('file-absolute').focus(); $('file-absolute').select(); message('file-feedback', '无法自动复制，路径已选中。请按 Ctrl+C，或在 macOS 上按 ⌘C。'); } }
  });
  $('reveal').addEventListener('click', async () => {
    const file = state.file; if (!file || $('reveal').disabled) return; $('reveal').disabled = true;
    try { await api('/api/reveal', { workspace_id: file.workspace_id, path: file.path }); if (state.file === file) message('file-feedback', '已请求打开文件所在目录，请在本机文件管理器中查看。'); }
    catch (error) { if (state.file === file) message('file-feedback', explain(error), true); }
    finally { if (state.file === file) $('reveal').disabled = false; }
  });
  let fragment = '';
  try { fragment = new URLSearchParams(location.hash.slice(1)).get('token') || ''; }
  catch {}
  try { if (location.hash) history.replaceState(null, '', location.pathname + location.search); }
  catch { message('notice', '无法清除地址中的临时凭据，请关闭此页后重新打开。', true); $('refresh').disabled = true; return; }
  try { state.token = fragment || sessionStorage.getItem(storageKey) || ''; if (fragment) sessionStorage.setItem(storageKey, fragment); }
  catch { state.token = fragment; }
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(state.token)) { state.token = ''; message('connection', '等待本机授权'); message('notice', '请通过本机启动命令打开带临时凭据的面板链接。配置文件中的 API key 不需要填写到此页面。'); return; }
  void refreshStatus();
})();
</script>
</body>
</html>`;
}
