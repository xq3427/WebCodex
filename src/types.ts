import type { DatabaseSync } from 'node:sqlite';
export interface WorkspaceConfig { id: string; uid?: string; name: string; root: string; readOnly: boolean; enabled?: boolean; onUnavailable?: 'error' | 'skip'; executionProfile?: string; worktree?: { gitDir: string; commonDir: string } }
export type ExecutableConfig = string | { command: string; args: string[] };
export interface ExecutionProfile { allowedExecutables: Record<string, ExecutableConfig>; env?: Record<string, string> }
export interface FileWidgetConfig { mode: 'automatic' | 'manual'; compact: boolean; closeAfterSend: boolean }
/** Legacy settings are accepted for migration only; no browser worker is shipped. */
export interface NativeAttachmentConfig {
  enabled: boolean;
  runtimeDir: string;
  browser: { engine: 'chromium'; channel: 'msedge' | 'chrome' | 'chromium'; userDataDir: string; executablePath: string | null };
  maxFileBytes: number; maxQueueJobs: number; uploadTimeoutMs: number; bindingTtlMs: number;
}
/** Retained only for reading and disabling historical experimental settings. */
export interface ActionsProbeQuickTunnelConfig { clientPath: string; startupTimeoutMs: number; proxyUrl?: string }
export interface ActionsProbeConfig { enabled: boolean; apiKey: string; publicBaseUrl: string; port: number; quickTunnel: ActionsProbeQuickTunnelConfig }
export interface AppConfig {
  version: 1 | 2; stateDir: string; configPath: string; workspaces: WorkspaceConfig[];
  device?: { id: string; name: string };
  toolsDir?: string;
  nodePath?: string;
  gitPath?: string;
  tunnel?: { enabled: boolean; id: string; apiKey: string; proxyUrl: string; clientPath: string; clientVersion: string; clientSha256?: string };
  server?: { transport: 'stdio' | 'http' };
  tasks?: {maxTasksPerWorkspace:number;maxRevisionsPerTask:number;maxTrackedFiles:number;maxSnapshotBytes:number};
  projectContext?: {maxDepth:number;maxFileBytes:number;maxTotalBytes:number};
  fileBatches?: {maxFiles:number;maxTotalBytes:number};
  fileWidget?: FileWidgetConfig;
  nativeAttachment?: NativeAttachmentConfig;
  diagnostics?: { enabled: boolean; maxEvents: number };
  actionsProbe?: ActionsProbeConfig;
  localPanel?: { port: number };
  execution: { mode: 'disabled' | 'trusted-host'; allowedExecutables: Record<string, ExecutableConfig>; env?: Record<string,string>; profiles?: Record<string, ExecutionProfile>; maxConcurrent: number; defaultTimeoutMs?: number; maxTimeoutMs: number; maxOutputBytes: number; defaultWaitMs?:number;maxWaitMs?:number;stdinMaxBytes?:number;stdinMaxTotalBytes?:number;stdinWriteTimeoutMs?:number };
  limits: { readMaxBytes: number; fileReadMaxBytes?: number; fileTransferMaxBytes?: number; fileWidgetUploadMaxBytes?: number; fileWidgetTicketTtlMs?: number; fileWidgetCacheMaxBytes?: number; fileWidgetChunkMaxBytes?: number; writeMaxBytes: number; searchMaxResults: number; listMaxEntries: number };
  rgPath: string;
  http: { port: number; bearerToken?: string };
  codexSessions: { enabled: boolean; home: string | null; maxWindowsPerRequest?: number; maxRecordBytes?: number };
}
export interface ResolveOptions { write?: boolean; allowMissing?: boolean; directory?: boolean }
export interface PathPolicy {
  get(workspaceId: string): WorkspaceConfig;
  resolve(workspaceId: string, relativePath: string, options?: ResolveOptions): Promise<string>;
  list(): WorkspaceConfig[];
}
export interface Store {
  db: DatabaseSync;
  idempotent<T>(scope: string, key: string, payload: unknown, action: () => Promise<T>): Promise<T>;
  audit(event: string, workspaceId: string | null, data: unknown): void;
}
export interface ServiceContext { config: AppConfig; paths: PathPolicy; store: Store }
