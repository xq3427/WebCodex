import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultConfig } from '../src/config.js';
import { App } from '../src/app.js';
import { createMcpServer } from '../src/server.js';
import { initializeIdentity } from '../src/identity.js';
import { WebSessionService } from '../src/web-sessions.js';
import { StateStore } from '../src/store.js';
import { WorkspacePaths } from '../src/paths.js';
import type { AppConfig, ServiceContext } from '../src/types.js';

test('workspace-scoped web session journal persists activity and checkpoints', async () => {
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'webcodex-sessions-'));
  const roots = [path.join(base, '论文'), path.join(base, '代码')];
  await Promise.all(roots.map(root => mkdir(root)));
  const configPath = path.join(base, 'config.json');
  const defaults = defaultConfig(roots[0], configPath);
  const config: AppConfig = { ...defaults, configPath, workspaces: roots.map((root, index) => ({ id: index ? 'code' : 'paper', name: path.basename(root), root, readOnly: false })) };
  const store = new StateStore(config.stateDir);
  const ctx: ServiceContext = { config, store, paths: new WorkspacePaths(config) };
  const identity = initializeIdentity(ctx);
  const service = new WebSessionService(ctx, identity);
  try {
    await service.recordCall({ workspaceId: 'paper', openaiSession: 'chat-a', tool: 'fs_read', input: { path: '论文.pdf' }, outcome: 'success', result: { ok: true } });
    const listed = await service.list({ workspace_id: 'paper' });
    assert.equal(listed.sessions.length, 1);
    const key = String((listed.sessions[0] as any).session_key);
    assert.match(key, /^[a-f0-9]{32}$/);
    await service.checkpoint({ workspace_id: 'paper', session_key: key, title: '论文阅读', summary: '完成读取，api_key=sk-proj-123456789012345678901234', next_steps: ['整理重点'], idempotency_key: 'cp-1' }, undefined);
    const page = await service.read({ workspace_id: 'paper', session_key: key });
    assert.equal(page.events.length, 1);
    assert.equal((page.events[0] as any).relative_paths[0], '论文.pdf');
    assert.equal((page.checkpoints[0] as any).summary.includes('sk-proj-'), false);
    service.beginTool('paper', { _meta: { 'openai/session': 'chat-a' } }, 'fs_read');
    await assert.rejects(service.appendTurn({ workspace_id: 'paper', session_key: key, user_message: '过早提交', assistant_reply: '仍有工具运行', idempotency_key: 'turn-busy' }, { _meta: { 'openai/session': 'chat-a' } }), { code: 'SESSION_TURN_BUSY' });
    service.endTool('paper', { _meta: { 'openai/session': 'chat-a' } }, 'fs_read');
    const turn = await service.appendTurn({ workspace_id: 'paper', session_key: key, user_message: '请读取论文摘要', assistant_reply: '已完成摘要读取，token=sk-proj-123456789012345678901234', idempotency_key: 'turn-1' }, undefined);
    assert.equal((turn as any).assistant_reply.includes('sk-proj-'), false);
    const turnPage = await service.read({ workspace_id: 'paper', session_key: key }) as any;
    assert.equal(turnPage.turns.length, 1);
    await assert.rejects(service.appendTurn({ workspace_id: 'paper', session_key: key, user_message: '不同请求', assistant_reply: '不同回复', idempotency_key: 'turn-1' }, undefined), { code: 'IDEMPOTENCY_CONFLICT' });
    const resume = await service.resume({ workspace_id: 'paper', session_key: key }, undefined);
    assert.equal((resume.current_session as any).session_key, key);
    const checkpoint = (await service.checkpoint({ workspace_id: 'paper', session_key: key, title: '论文阅读', summary: '完成读取，api_key=sk-proj-123456789012345678901234', next_steps: ['整理重点'], idempotency_key: 'cp-1' }, undefined)) as any;
    assert.equal(checkpoint.replayed, true);
    await assert.rejects(service.checkpoint({ workspace_id: 'paper', session_key: key, title: '论文阅读', summary: 'different', idempotency_key: 'cp-1' }, undefined), { code: 'IDEMPOTENCY_CONFLICT' });
    const second = await service.recordCall({ workspaceId: 'paper', openaiSession: 'chat-b', tool: 'fs_read', input: { path: 'b.txt' }, outcome: 'success' });
    void second;
    const firstPage = await service.list({ workspace_id: 'paper', limit: 1 });
    assert.equal(firstPage.sessions.length, 1);
    assert.ok(firstPage.next_cursor);
    const secondPage = await service.list({ workspace_id: 'paper', limit: 1, cursor: firstPage.next_cursor! });
    assert.equal(secondPage.sessions.length, 1);
    const other = await service.list({ workspace_id: 'code' });
    assert.equal(other.sessions.length, 0);
    await stat(path.join(roots[0], '.webcodex', 'sessions', 'sessions.sqlite'));
  } finally {
    service.close();
    store.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('real MCP handler receives openai session metadata and journals activity in the selected workspace', async () => {
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'webcodex-session-metadata-'));
  const root = path.join(base, 'project');
  await mkdir(root);
  await writeFile(path.join(root, 'note.txt'), 'metadata test\n');
  const configPath = path.join(base, 'config.json');
  const config = { ...defaultConfig(root, configPath), configPath } as AppConfig;
  const app = new App(config);
  const server = createMcpServer(app);
  const client = new Client({ name: 'webcodex-session-metadata-test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: 'fs_stat',
      arguments: { workspace_id: 'default', path: 'note.txt' },
      _meta: { 'openai/session': 'synthetic-session' },
    } as any);
    assert.equal((response.structuredContent as any)?.ok, true);
    assert.equal((response.structuredContent as any)?.journal?.pending, true);
    assert.equal((response.structuredContent as any)?.journal?.state, 'pending');
    const turnResponse = await client.callTool({
      name: 'web_session_turn',
      arguments: { workspace_id: 'default', user_message: '记录这条用户消息', assistant_reply: '这是 GPT 的显式回复', idempotency_key: 'metadata-turn-1' },
      _meta: { 'openai/session': 'synthetic-session' },
    } as any);
    assert.equal((turnResponse.structuredContent as any)?.ok, true);
    assert.equal((turnResponse.structuredContent as any)?.journal?.pending, false);
    assert.equal((turnResponse.structuredContent as any)?.journal?.state, 'committed');
    const afterCommit = await client.callTool({
      name: 'fs_stat',
      arguments: { workspace_id: 'default', path: 'note.txt' },
      _meta: { 'openai/session': 'synthetic-session' },
    } as any);
    assert.equal((afterCommit.structuredContent as any)?.journal?.pending, true);
    assert.notEqual((afterCommit.structuredContent as any)?.journal?.activity_epoch_id, (turnResponse.structuredContent as any)?.journal?.activity_epoch_id);
    const listed = await app.webSessions.list({ workspace_id: 'default' });
    assert.equal(listed.sessions.length, 1);
    const page = await app.webSessions.read({ workspace_id: 'default', session_key: String((listed.sessions[0] as any).session_key) }) as any;
    assert.equal(page.events[0]?.tool_name, 'fs_stat');
    assert.equal(page.turns[0]?.assistant_reply, '这是 GPT 的显式回复');
  } finally {
    await client.close();
    await server.close();
    await app.close();
    await rm(base, { recursive: true, force: true });
  }
});
