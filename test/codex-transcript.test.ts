import test from 'node:test';
import assert from 'node:assert/strict';
import { capUtf8, projectCodexRecord } from '../src/codex-transcript.js';

const response = (payload: unknown) => ({ timestamp: '2026-09-08T01:00:00Z', type: 'response_item', payload });
test('Codex transcript projects visible response messages and ignores duplicate event mirrors', () => {
  assert.deepEqual(projectCodexRecord(response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续修改项目' }] })), {
    kind: 'message', role: 'user', timestamp: '2026-09-08T01:00:00.000Z', text: '继续修改项目',
  });
  assert.equal(projectCodexRecord(response({ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '检查构建结果' }] }))?.phase, 'commentary');
  assert.equal(projectCodexRecord(response({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '构建通过' }] }))?.text, '构建通过');
  for (const payload of [
    { type: 'user_message', message: '继续修改项目' },
    { type: 'agent_message', message: '构建通过' },
    { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: '构建通过' }] } },
  ]) assert.equal(projectCodexRecord({ type: 'event_msg', payload }), null);
});

test('Codex transcript excludes hidden reasoning, instructions and unknown message phases even with tools enabled', () => {
  for (const payload of [
    { type: 'reasoning', summary: 'PRIVATE', encrypted_content: 'PRIVATE' },
    { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'PRIVATE' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'PRIVATE' }] },
    { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'PRIVATE' }] },
    { type: 'message', role: 'assistant', phase: 'analysis', content: [{ type: 'output_text', text: 'PRIVATE' }] },
    { type: 'message', role: 'assistant', phase: 'unknown_future_phase', content: [{ type: 'output_text', text: 'PRIVATE' }] },
  ]) assert.equal(projectCodexRecord(response(payload), true), null);
  for (const type of ['session_meta', 'turn_context', 'compacted', 'event_msg']) assert.equal(projectCodexRecord({ type, payload: { text: 'PRIVATE', base_instructions: 'PRIVATE' } }, true), null);
});

test('Codex transcript includes tools only on request and omits binary/attachment bodies', () => {
  const call = response({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}', call_id: 'call_1' });
  assert.equal(projectCodexRecord(call), null);
  assert.equal(projectCodexRecord(call, true)?.name, 'exec_command');
  assert.equal(projectCodexRecord(response({ type: 'custom_tool_call_output', call_id: 'call_1', output: 'exit_code: 0' }), true)?.text, 'exit_code: 0');
  const message = projectCodexRecord(response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '请检查附件' }, { type: 'input_image', image_url: 'data:image/png;base64,PRIVATE' }] }));
  assert.equal(message?.nontext_parts, 1);
  assert.equal(message?.text, '请检查附件');
  const output = projectCodexRecord(response({ type: 'function_call_output', output: [{ type: 'text', text: 'visible result' }, { type: 'image', data: 'PRIVATE' }] }), true);
  assert.equal(output?.text, 'visible result');
  assert.equal(projectCodexRecord({ type: 'response_item', payload: null }), null);
  assert.equal(projectCodexRecord(null), null);
});

test('UTF-8 transcript budgets never split a character', () => {
  assert.deepEqual(capUtf8('中a🙂', 6), { text: '中a', bytes: 4, truncated: true });
  assert.deepEqual(capUtf8('中', 2), { text: '', bytes: 0, truncated: true });
});
