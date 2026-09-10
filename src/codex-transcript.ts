export interface CodexTranscriptItem {
  kind: 'message' | 'tool_call' | 'tool_result';
  role?: 'user' | 'assistant';
  phase?: 'commentary' | 'final_answer';
  timestamp: string | null;
  text: string;
  name?: string;
  call_id?: string;
  nontext_parts?: number;
}

const object = (value: unknown): Record<string, any> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
const shortId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(value) ? value : undefined;

/** Project only user-visible response items. Event mirrors, reasoning and policy payloads stay private. */
export function projectCodexRecord(value: unknown, includeTools = false): CodexTranscriptItem | null {
  const record = object(value);
  if (!record || record.type !== 'response_item') return null;
  const item = object(record.payload);
  if (!item) return null;
  let timestamp: string | null = null;
  if (typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp))) timestamp = new Date(record.timestamp).toISOString();
  // Some versions retain channel, newer versions use phase. Unknown assistant phases are excluded.
  if (item.channel !== undefined && !['final', 'commentary'].includes(item.channel)) return null;
  if (item.type === 'message') {
    if (item.role !== 'user' && item.role !== 'assistant') return null;
    if (item.role === 'assistant' && item.phase != null && !['final_answer', 'commentary', 'final'].includes(item.phase)) return null;
    if (!Array.isArray(item.content)) return null;
    const pieces: string[] = [];
    let omitted = 0;
    for (const raw of item.content) {
      const part = object(raw);
      if (part && ['input_text', 'output_text', 'text'].includes(part.type) && typeof part.text === 'string') pieces.push(part.text);
      else omitted++;
    }
    if (!pieces.length && !omitted) return null;
    const phase = item.phase === 'commentary' || item.channel === 'commentary' ? 'commentary' : 'final_answer';
    return {
      kind: 'message', role: item.role, timestamp, text: pieces.join('\n'),
      ...(item.role === 'assistant' ? { phase } : {}),
      ...(omitted ? { nontext_parts: omitted } : {}),
    };
  }
  if (!includeTools) return null;
  if (item.type === 'function_call' || item.type === 'custom_tool_call') {
    const input = item.type === 'function_call' ? item.arguments : item.input;
    return { kind: 'tool_call', timestamp, text: typeof input === 'string' ? input : '[Non-text tool arguments omitted]', name: shortId(item.name), call_id: shortId(item.call_id) };
  }
  if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
    let text = '';
    if (typeof item.output === 'string') text = item.output;
    else if (Array.isArray(item.output)) {
      text = item.output.map(object).filter(part => part && ['input_text', 'output_text', 'text'].includes(part.type) && typeof part.text === 'string').map(part => part!.text).join('\n');
    }
    return { kind: 'tool_result', timestamp, text: text || '[Non-text tool output omitted]', call_id: shortId(item.call_id) };
  }
  return null;
}

export function capUtf8(text: string, maxBytes: number) {
  const bytes = Buffer.from(text, 'utf8');
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: end < bytes.length, bytes: end };
}
