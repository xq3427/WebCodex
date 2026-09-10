import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, errorResult } from './errors.js';
import type { Store } from './types.js';

export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
}
export class StateStore implements Store {
  db!: DatabaseSync;
  private lockPath: string;
  private owner = randomUUID();
  private lease?: DatabaseSync;
  private inFlight = new Map<string, Promise<unknown>>();
  private closed = false;
  constructor(stateDir: string, options: { expectedDeviceId?: string } = {}) {
    mkdirSync(stateDir,{recursive:true});
    if (lstatSync(stateDir).isSymbolicLink()) throw new AppError('CONFIG_ERROR','State directory may not be a link.');
    this.lockPath = path.join(stateDir,'daemon.lock');
    // SQLite's OS lock is the ownership boundary. It is released on process exit,
    // including crashes; a JSON PID file alone has stale-recovery races.
    try { this.lease=new DatabaseSync(path.join(stateDir,'owner.sqlite'));this.lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
    catch { this.lease?.close();this.lease=undefined;throw new AppError('STATE_LOCKED','Another daemon owns this state directory, or its lock cannot be acquired.'); }
    try {
      writeFileSync(this.lockPath,JSON.stringify({pid:process.pid,owner:this.owner}),{mode:0o600});
      this.db = new DatabaseSync(path.join(stateDir,'webcodex.sqlite'));
      if(options.expectedDeviceId && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='webcodex_state_identity'").get()) {
        const saved=this.db.prepare('SELECT device_id FROM webcodex_state_identity WHERE singleton=1').get();
        if(saved && saved.device_id!==options.expectedDeviceId)throw new AppError('STATE_DEVICE_MISMATCH','This state directory belongs to another device ID. Use its original identity or a new local state directory.');
      }
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS operations (scope TEXT NOT NULL, op_key TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, PRIMARY KEY(scope,op_key));
        CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, workspace_id TEXT, details TEXT NOT NULL, created_at TEXT NOT NULL);
        UPDATE operations SET status='unknown' WHERE status='pending';`);
    } catch (error) { this.db?.close(); this.releaseLock(); throw error; }
  }
  async idempotent<T>(scope: string,key: string,payload: unknown,action:()=>Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) throw new AppError('INVALID_IDEMPOTENCY_KEY','Use a 1–128 character stable operation ID.');
    const digest = createHash('sha256').update(canonical(payload)).digest('hex');
    const row = this.db.prepare('SELECT digest,status,result FROM operations WHERE scope=? AND op_key=?').get(scope,key) as {digest:string;status:string;result:string|null}|undefined;
    const mapKey = canonical([scope,key]);
    if (row) {
      if (row.digest !== digest) throw new AppError('IDEMPOTENCY_CONFLICT','This operation ID was already used with different arguments.');
      if (row.status === 'done') return JSON.parse(row.result!) as T;
      if (row.status === 'failed') { const e = JSON.parse(row.result!); throw new AppError(e.code,e.message,e.details); }
      if (this.inFlight.has(mapKey)) return this.inFlight.get(mapKey) as Promise<T>;
      throw new AppError('EXECUTION_UNKNOWN','A previous attempt may have run. Inspect its job or change record before retrying with a new ID.');
    }
    this.db.prepare("INSERT INTO operations(scope,op_key,digest,status,created_at) VALUES(?,?,?,'pending',?)").run(scope,key,digest,new Date().toISOString());
    const pending = Promise.resolve().then(action).then(result => {
      this.db.prepare("UPDATE operations SET status='done',result=? WHERE scope=? AND op_key=?").run(JSON.stringify(result),scope,key);
      return result;
    }, error => {
      const safe = errorResult(error);
      this.db.prepare("UPDATE operations SET status='failed',result=? WHERE scope=? AND op_key=?").run(JSON.stringify(safe.error),scope,key);
      throw error;
    }).finally(()=>this.inFlight.delete(mapKey));
    this.inFlight.set(mapKey,pending);
    return pending;
  }
  audit(event: string,workspaceId: string|null,data:unknown) { this.db.prepare('INSERT INTO audit_events(event,workspace_id,details,created_at) VALUES(?,?,?,?)').run(event,workspaceId,JSON.stringify(data),new Date().toISOString()); }
  private releaseLock() { try { if (JSON.parse(readFileSync(this.lockPath,'utf8')).owner === this.owner) unlinkSync(this.lockPath); } catch {} finally {this.lease?.close();this.lease=undefined;} }
  close() { if (this.closed) return; this.closed=true; try { this.db.close(); } finally { this.releaseLock(); } }
}
