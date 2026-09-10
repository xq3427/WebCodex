import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppConfig } from './types.js';
import type { App } from './app.js';
import { VERSION } from './version.js';

const methods = new Set(['initialize', 'tools/list', 'tools/call', 'resources/list', 'resources/read']);
const safeCodes = new Set(['DEVICE_MISMATCH','WORKSPACE_NOT_FOUND','WORKSPACE_UNAVAILABLE','WORKSPACE_DISABLED','WORKSPACE_RESTART_REQUIRED','WORKSPACE_IDENTITY_MISMATCH','READ_ONLY','PATH_DENIED','NOT_FOUND','ACCESS_DENIED','ALREADY_EXISTS','FILE_BUSY','FILE_TOO_LARGE','BINARY_FILE','VERSION_CONFLICT','IDEMPOTENCY_CONFLICT','EXECUTION_DISABLED','EXECUTABLE_NOT_ALLOWED','INVALID_ARGUMENT','FILE_WIDGET_TICKET_NOT_FOUND','FILE_WIDGET_CACHE_FULL','FILE_WIDGET_EXPIRED','SERVICE_CLOSING']);
type Observation = { trace: string; started: number };
type Completion = { outcome: string; stage: string; error_code: string | null };

/** Diagnostics contain fixed protocol metadata only: never arguments, outputs, headers or remote IDs. */
export class McpDiagnostics {
  readonly enabled: boolean;
  readonly maxEvents: number;
  private readonly names = new Set<string>();
  private degraded = false;
  constructor(private db: DatabaseSync, private config: AppConfig, private instanceId: string) {
    this.enabled = config.diagnostics?.enabled ?? true;
    this.maxEvents = config.diagnostics?.maxEvents ?? 1000;
    if (this.enabled) this.safely(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS mcp_diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, trace_id TEXT UNIQUE NOT NULL, instance_id TEXT NOT NULL,
        version TEXT NOT NULL, method TEXT NOT NULL, tool TEXT, outcome TEXT NOT NULL, stage TEXT NOT NULL,
        error_code TEXT, started_at TEXT NOT NULL, duration_ms INTEGER)`);
      this.trim();
    });
  }
  registerTool(name: string) { this.names.add(name); }
  private safely(action: () => void) { try { action(); } catch { this.degraded = true; } }
  private trim() { this.db.prepare('DELETE FROM mcp_diagnostics WHERE id NOT IN (SELECT id FROM mcp_diagnostics ORDER BY id DESC LIMIT ?)').run(this.maxEvents); }
  begin(message: JSONRPCMessage): Observation | undefined {
    if (!this.enabled || !('method' in message) || messageId(message)===undefined || !methods.has(message.method)) return;
    const trace = randomUUID(), started = Date.now();
    const candidate = message.method === 'tools/call' ? (message.params as {name?:unknown}|undefined)?.name : null;
    const tool = typeof candidate === 'string' && this.names.has(candidate) ? candidate : message.method === 'tools/call' ? '<unknown>' : null;
    this.safely(() => {
      this.db.prepare('INSERT INTO mcp_diagnostics(trace_id,instance_id,version,method,tool,outcome,stage,started_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(trace,this.instanceId,VERSION,message.method,tool,'received','received',new Date(started).toISOString());
      this.trim();
    });
    return {trace,started};
  }
  finish(observation: Observation, result: Completion) {
    this.safely(() => this.db.prepare('UPDATE mcp_diagnostics SET outcome=?,stage=?,error_code=?,duration_ms=? WHERE trace_id=?')
      .run(result.outcome,result.stage,result.error_code,Math.max(0,Date.now()-observation.started),observation.trace));
  }
  snapshot() {
    let recent: unknown[] = [];
    if (this.enabled) this.safely(() => { recent = readRows(this.db, 5, this.instanceId); });
    return { enabled:this.enabled, available:this.enabled && !this.degraded, max_events:this.maxEvents, scope:'bounded_protocol_metadata', current_instance_only:true, recent,
      local_command:'webcodex-mcp diagnostics show', limitation:'A sent MCP response does not prove ChatGPT displayed, parsed or used it. Missing events cannot prove which apps a chat selected.' };
  }
}

function completion(message: JSONRPCMessage): Completion {
  if ('error' in message) return {outcome:'rejected',stage:'protocol',error_code:typeof message.error.code==='number' ? String(message.error.code) : 'PROTOCOL_ERROR'};
  const result = 'result' in message ? message.result as Record<string,unknown> : undefined;
  if (result?.isError === true) {
    const code = (result.structuredContent as {error?:{code?:unknown}}|undefined)?.error?.code;
    if (typeof code === 'string') return {outcome:'rejected',stage:'tool',error_code:safeCodes.has(code) ? code : 'OTHER_TOOL_ERROR'};
    const text = Array.isArray(result.content) ? result.content.find(c=>c?.type==='text' && typeof c.text==='string')?.text.slice(0,100) : '';
    return /^MCP error -32602: Input validation error/.test(text) ? {outcome:'rejected',stage:'input_validation',error_code:'-32602'}
      : {outcome:'rejected',stage:'dispatch_or_validation',error_code:'SDK_TOOL_ERROR'};
  }
  return {outcome:'responded',stage:'response_sent',error_code:null};
}

/** Observe the public transport boundary, including SDK rejection before a tool handler runs. */
export function observeMcpTransport(inner: Transport, diagnostics: McpDiagnostics): Transport {
  const pending = new Map<RequestId,Observation>();
  const abandon = () => {
    for (const observation of pending.values()) diagnostics.finish(observation,{outcome:'unconfirmed',stage:'transport_closed',error_code:null});
    pending.clear();
  };
  const wrapper: Transport = {
    get sessionId() { return inner.sessionId; },
    setProtocolVersion: inner.setProtocolVersion ? version=>inner.setProtocolVersion!(version) : undefined,
    async start() {
      const previousMessage=inner.onmessage,previousError=inner.onerror,previousClose=inner.onclose;
      inner.onmessage = (message,extra) => {
        previousMessage?.(message,extra);
        const observation = diagnostics.begin(message);
        const id = messageId(message);
        if (observation && id!==undefined) {
          if (pending.size >= diagnostics.maxEvents) {
            const oldest = pending.entries().next().value;
            if (oldest) { diagnostics.finish(oldest[1],{outcome:'unconfirmed',stage:'tracking_capacity',error_code:null}); pending.delete(oldest[0]); }
          }
          const prior = pending.get(id);
          if (prior) diagnostics.finish(prior,{outcome:'unconfirmed',stage:'duplicate_request_id',error_code:null});
          pending.set(id,observation);
        }
        wrapper.onmessage?.(normalizeToolArguments(message),extra);
      };
      inner.onerror = error => { previousError?.(error); wrapper.onerror?.(error); };
      inner.onclose = () => { previousClose?.(); abandon(); wrapper.onclose?.(); };
      await inner.start();
    },
    async send(message,options) {
      const id = !('method' in message) ? messageId(message) : undefined;
      const observation = id!==undefined ? pending.get(id) : undefined;
      const current = () => observation!==undefined && id!==undefined && pending.get(id)===observation;
      try {
        await inner.send(message,options);
        if (observation && current()) diagnostics.finish(observation,completion(message));
      } catch (error) {
        if (observation && current()) diagnostics.finish(observation,{outcome:'unconfirmed',stage:'send_failed',error_code:null});
        throw error;
      } finally { if (id!==undefined && current()) pending.delete(id); }
    },
    async close() { try { await inner.close(); } finally { abandon(); } }
  };
  return wrapper;
}

/** MCP permits omitted tool arguments. Preserve malformed values for the SDK to reject. */
function normalizeToolArguments(message: JSONRPCMessage): JSONRPCMessage {
  if (!('method' in message) || message.method !== 'tools/call' || messageId(message) === undefined) return message;
  const params = message.params;
  if (!params || typeof params !== 'object' || Array.isArray(params) || params.arguments !== undefined) return message;
  return { ...message, params: { ...params, arguments: {} } };
}

function messageId(message:JSONRPCMessage):RequestId|undefined {
  if ('id' in message && (typeof message.id==='string' || typeof message.id==='number')) return message.id;
}

export class WebCodexMcpServer extends McpServer {
  constructor(private app: App, info: ConstructorParameters<typeof McpServer>[0], options?: ConstructorParameters<typeof McpServer>[1]) { super(info,options); }
  override connect(transport: Transport) { return super.connect(observeMcpTransport(transport,this.app.diagnostics)); }
}

function readRows(db:DatabaseSync,limit:number,instanceId?:string) {
  return instanceId ? db.prepare('SELECT trace_id,instance_id,version,method,tool,outcome,stage,error_code,started_at,duration_ms FROM mcp_diagnostics WHERE instance_id=? ORDER BY id DESC LIMIT ?').all(instanceId,limit)
    : db.prepare('SELECT trace_id,instance_id,version,method,tool,outcome,stage,error_code,started_at,duration_ms FROM mcp_diagnostics ORDER BY id DESC LIMIT ?').all(limit);
}

/** Local CLI only: inspect an active daemon without acquiring its StateStore lease. */
export function readMcpDiagnostics(config: AppConfig,limit=20) {
  const base = {enabled:config.diagnostics?.enabled ?? true,max_events:config.diagnostics?.maxEvents ?? 1000,read_only:true,
    limitation:'Records show local protocol handling, not whether ChatGPT can access a tool or read an attachment.'};
  const databasePath = path.join(config.stateDir,'webcodex.sqlite');
  try {
    const metadata = lstatSync(databasePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink!==1) return {...base,available:false,reason:'state_unavailable',events:[]};
    const db = new DatabaseSync(databasePath,{readOnly:true});
    try {
      db.exec('PRAGMA query_only=ON');
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_diagnostics'").get();
      return exists ? {...base,available:true,events:readRows(db,Math.min(100,Math.max(1,limit)))}
        : {...base,available:false,reason:'no_diagnostic_records_upgrade_or_start_service',events:[]};
    } finally { db.close(); }
  } catch { return {...base,available:false,reason:'state_unavailable',events:[]}; }
}
