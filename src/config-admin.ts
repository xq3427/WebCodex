import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import { executableDefinition, expandConfigPath, loadConfig, resolveCodexHome, validateConfig } from './config.js';
import { configFormatForPath, parseConfigText, serializeConfig } from './config-format.js';
import { protectConfigFile } from './config-permissions.js';
import { AppError } from './errors.js';
import { isProtectedName } from './paths.js';
import type { AppConfig, ExecutableConfig } from './types.js';
import { assertWorkspaceRoot, detectLinkedWorktree, type WorktreeAuthorization } from './worktree-policy.js';
import { workspaceDefaults, type WorkspaceInput } from './workspace-config.js';
import { publicWorkspaceExecution } from './execution-profiles.js';
import { workspaceHealth } from './workspace-health.js';

export type RawConfig = Record<string, unknown> & {
  version: 1 | 2;
  device?: { id: string; name: string };
  workspaces: WorkspaceInput[];
  execution: Record<string, unknown> & { mode?: 'disabled' | 'trusted-host'; allowedExecutables?: Record<string, ExecutableConfig> };
  codexSessions?: { enabled?: boolean; home?: string | null; maxWindowsPerRequest?: number; maxRecordBytes?: number };
};
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// Windows lstat may report dev=0 while fstat reports the volume ID. Inodes need bigint on NTFS.
const sameFile = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && a.birthtimeNs === b.birthtimeNs &&
  (a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0n || b.dev === 0n)));
const contains = (root: string, target: string) => { const rel = path.relative(root, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };

/** Explicit field allowlist: do not print raw config, environment, keys, or fixed argument values. */
export function publicConfig(config: AppConfig) {
  return {
    config: config.configPath,
    version: config.version,
    ...(config.device ? { device: { id: config.device.id, name: config.device.name } } : {}),
    state_dir: config.stateDir,
    ...(config.toolsDir ? { tools_dir: config.toolsDir } : {}),
    ...(config.nodePath ? { node_path: config.nodePath } : {}),
    ...(config.gitPath ? { git_path: config.gitPath } : {}),
    workspaces: config.workspaces.map(w => ({ workspace_id: w.id, ...(w.uid ? { uid: w.uid } : {}), name: w.name, root: w.root, read_only: w.readOnly, enabled: w.enabled !== false, on_unavailable: w.onUnavailable ?? 'error', ...workspaceHealth(config,w), execution: publicWorkspaceExecution(config,w.id), ...(w.worktree ? {worktree:w.worktree} : {}) })),
    execution: {
      mode: config.execution.mode,
      command_policy: config.execution.commandPolicy ?? 'allowlist',
      profiles: Object.keys(config.execution.profiles ?? {}).sort(),
      configured_environment_names:Object.keys(config.execution.env??{}).sort(),
      executables: Object.entries(config.execution.allowedExecutables).map(([alias, value]) => {
        const executable = executableDefinition(value);
        return { alias, command: executable.command, prefix_arg_count: executable.args.length };
      }),
      max_concurrent: config.execution.maxConcurrent,
      default_timeout_ms: config.execution.defaultTimeoutMs ?? Math.min(60000, config.execution.maxTimeoutMs),
      max_timeout_ms: config.execution.maxTimeoutMs,
      max_output_bytes: config.execution.maxOutputBytes,
      default_wait_ms:config.execution.defaultWaitMs??1000,
      max_wait_ms:config.execution.maxWaitMs??20000,
      stdin_max_bytes:config.execution.stdinMaxBytes??65536,
      stdin_max_total_bytes:config.execution.stdinMaxTotalBytes??1048576,
      stdin_write_timeout_ms:config.execution.stdinWriteTimeoutMs??5000,
    },
    rg_path: config.rgPath,
    http_port: config.http.port,
    http_bearer_token_configured: Boolean(config.http.bearerToken),
    ...(config.server ? { server: { transport: config.server.transport } } : {}),
    ...(config.tunnel ? { tunnel: { enabled: config.tunnel.enabled, id: config.tunnel.id, api_key_configured: Boolean(config.tunnel.apiKey), proxy_configured: Boolean(config.tunnel.proxyUrl), client_path: config.tunnel.clientPath, client_version: config.tunnel.clientVersion, client_sha256_configured: Boolean(config.tunnel.clientSha256) } } : {}),
    limits: config.limits,
    ...(config.nativeAttachment ? { native_attachment: { active: false, legacy: true, notice: 'Historical browser attachment settings are inactive. Automatic original-file upload is deferred.' } } : {}),
    diagnostics: config.diagnostics ?? { enabled: true, maxEvents: 1000 },
    ...(config.localPanel ? { localPanel: { port: config.localPanel.port } } : {}),
    ...(config.actionsProbe ? { actionsProbe: { active: false, legacy: true, notice: 'Historical Actions probe settings are inactive. The default application does not start or install this archived experiment.' } } : {}),
    tasks:config.tasks,
    project_context:config.projectContext,
    file_batches:config.fileBatches??{maxFiles:20,maxTotalBytes:4194304},
    binary_inputs:config.binaryInputs??{chunkMaxBytes:12288,maxSessions:4,maxCacheBytes:1048576,ttlMs:900000},
    file_imports:config.fileImports??{maxAttempts:3,downloadTimeoutMs:60000},
    codex_sessions: { enabled: config.codexSessions.enabled, home: config.codexSessions.home, ...(config.codexSessions.maxWindowsPerRequest !== undefined ? { max_windows_per_request: config.codexSessions.maxWindowsPerRequest } : {}), ...(config.codexSessions.maxRecordBytes !== undefined ? { max_record_bytes: config.codexSessions.maxRecordBytes } : {}) },
  };
}

async function noLinks(target: string): Promise<void> {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new AppError('CONFIG_PATH_DENIED', 'Configuration edits and new workspace roots cannot traverse links or junctions.');
  }
}

async function snapshot(fullPath: string) {
  await noLinks(fullPath);
  const before = await lstat(fullPath, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > 1048576n) throw new AppError('CONFIG_PATH_DENIED', 'Configuration must be a regular file of at most 1 MiB without hard links.');
  const file = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat({ bigint: true });
    if (!sameFile(before, info) || info.nlink !== 1n || !info.isFile()) throw new AppError('CONFIG_CONFLICT', 'Configuration changed while it was being read. Retry from the current configuration.');
    const bytes = await file.readFile();
    if (!sameFile(info, await lstat(fullPath, { bigint: true }))) throw new AppError('CONFIG_CONFLICT', 'Configuration changed while it was being read.');
    return { bytes, info, sha256: digest(bytes) };
  } finally { await file.close(); }
}

async function removeOwned(fullPath: string, info: BigIntStats): Promise<void> {
  try { if (sameFile(info, await lstat(fullPath, { bigint: true }))) await unlink(fullPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Local-only edits. A live server keeps its startup configuration until the owner restarts it. */
export async function editConfig(configPath: string, edit: (raw: RawConfig, current: AppConfig) => void | Promise<void>, expectedSha256?: string) {
  return editConfigLocked(configPath, edit, expectedSha256);
}

/** Internal local editor input. Raw data includes secrets and must never be sent to a browser or log. */
export async function readConfigDocument(configPath: string) {
  const fullPath = path.resolve(configPath);
  const format = configFormatForPath(fullPath);
  const source = await snapshot(fullPath);
  const originalText = source.bytes.toString('utf8');
  return { fullPath, format, originalText, revision: source.sha256, raw: parseConfigText(originalText, format) as RawConfig };
}

/** A repair view does not activate features or read Codex state; final writes still fully validate. */
export async function validatePanelConfigBaseline(raw: RawConfig, fullPath: string) {
  const baseline = structuredClone(raw);
  if (baseline.codexSessions && typeof baseline.codexSessions === 'object' && !Array.isArray(baseline.codexSessions)) baseline.codexSessions.enabled = false;
  if (baseline.tunnel && typeof baseline.tunnel === 'object' && !Array.isArray(baseline.tunnel) && !isPublicProxyUrl((baseline.tunnel as Record<string,unknown>).proxyUrl)) (baseline.tunnel as Record<string,unknown>).proxyUrl = '';
  return validateConfig(baseline, fullPath, { workspaceDiagnostics: true });
}

/** Only plain HTTP(S) proxy origins may appear in local UI. Credentials and signed URLs are private. */
export function isPublicProxyUrl(value: unknown): value is string {
  if (value === '' || value === undefined) return true;
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) return false;
  try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'; }
  catch { return false; }
}

/** Only the panel allowlist may call this path, to repair unavailable workspaces or Codex home. */
export async function editPanelConfig(configPath: string, edit: (raw: RawConfig, current: AppConfig) => void | Promise<void>, expectedSha256: string) {
  return editConfigLocked(configPath, edit, expectedSha256, false, undefined, undefined, true);
}

/** Materialize only the explicitly selected entry; pin defaults before disabling or moving its root. */
async function editableWorkspace(raw: RawConfig, fullPath: string, id: string): Promise<Exclude<WorkspaceInput, string>> {
  if (!raw || !Array.isArray(raw.workspaces)) throw new AppError('CONFIG_ERROR', 'Configuration validation failed.');
  const matches: Array<{ index: number; canonical: string; entry: Exclude<WorkspaceInput,string> }> = [];
  for (const [index, entry] of raw.workspaces.entries()) {
    const item = typeof entry === 'string' ? { root: entry } : entry;
    if (!item || typeof item !== 'object' || typeof item.root !== 'string') continue;
    if (item.id !== undefined && item.id !== id) continue;
    const context = { configDir: path.dirname(fullPath), userHome: homedir(), nodePath: process.execPath };
    if (typeof raw.nodePath === 'string' && raw.nodePath !== 'auto') context.nodePath = expandConfigPath(raw.nodePath, context);
    let canonical: string;
    try { canonical = raw.version === 2 ? expandConfigPath(item.root, context) : path.resolve(context.configDir, item.root); }
    catch (error) { if (item.id !== id) throw error; canonical = item.root; }
    if (item.enabled !== false) try { canonical = await realpath(canonical); } catch { /* A missing selected directory can be disabled or rebound. */ }
    const generated = raw.version === 2 && raw.device && typeof raw.device.id === 'string' && /^[a-f0-9-]{36}$/i.test(raw.device.id) ? workspaceDefaults(raw.device.id, canonical) : undefined;
    if ((item.id ?? generated?.id) === id) matches.push({index,canonical,entry:{ ...(generated ? {uid:generated.uid,name:generated.name}:{}),...item,id }});
  }
  if (matches.length !== 1) throw new AppError('WORKSPACE_NOT_FOUND', 'A unique workspace ID must already be configured.');
  raw.workspaces[matches[0].index] = matches[0].entry;
  return matches[0].entry;
}

async function editConfigLocked(configPath: string, edit: (raw: RawConfig, current: AppConfig) => void | Promise<void>, expectedSha256?: string, disableCodexSessionsOnly = false, repairWorkspace?: { id: string; root: string; readOnly?: boolean; newIdentity?: boolean; worktree?:WorktreeAuthorization }, toggleWorkspace?: { id: string; enabled: boolean }, panelRepair = false) {
  const fullPath = path.resolve(configPath);
  const format = configFormatForPath(fullPath);
  await noLinks(fullPath);
  const lockPath = fullPath + '.lock';
  let lock: FileHandle;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('CONFIG_LOCKED', 'Another configuration edit owns the lock. A stale lock requires local inspection before manual removal.');
    throw error;
  }
  const lockInfo = await lock.stat({ bigint: true });
  let temporary: { path: string; info: BigIntStats } | undefined;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }) + '\n');
    const original = await snapshot(fullPath);
    if (expectedSha256 !== undefined && expectedSha256 !== original.sha256) throw new AppError('CONFIG_CONFLICT', 'Configuration does not match the expected SHA-256.');
    const originalText = original.bytes.toString('utf8');
    const raw = parseConfigText(originalText, format) as RawConfig;
    // Turning this one feature off must remain possible after its home directory disappears.
    // Every other field is still validated unchanged before any edit or write is allowed.
    if (disableCodexSessionsOnly && raw !== null && typeof raw === 'object' && raw.codexSessions !== null && typeof raw.codexSessions === 'object' && !Array.isArray(raw.codexSessions) && raw.codexSessions.enabled === true) raw.codexSessions.enabled = false;
    if (toggleWorkspace) {
      if (raw.version !== 2) throw new AppError('CONFIG_MIGRATION_REQUIRED', 'Workspace enable/disable requires version 2 configuration.');
      (await editableWorkspace(raw, fullPath, toggleWorkspace.id)).enabled = toggleWorkspace.enabled;
    }
    let oldRoot: unknown;
    if (repairWorkspace) {
      if (repairWorkspace.newIdentity && raw.version !== 2) throw new AppError('CONFIG_MIGRATION_REQUIRED', 'A new workspace identity requires version 2 configuration.');
      const matched = await editableWorkspace(raw, fullPath, repairWorkspace.id);
      oldRoot = matched.root;
      if (typeof oldRoot !== 'string' || !oldRoot.length) throw new AppError('CONFIG_ERROR', 'The prior workspace root must be a path string.');
      // Only this root is substituted to validate the rest of the otherwise unchanged configuration.
      matched.root = repairWorkspace.root;
      if (repairWorkspace.readOnly !== undefined) matched.readOnly = repairWorkspace.readOnly;
      if(repairWorkspace.worktree) matched.worktree=repairWorkspace.worktree;
      else delete matched.worktree;
    }
    const current = panelRepair ? await validatePanelConfigBaseline(raw, await realpath(fullPath)) : await validateConfig(raw, await realpath(fullPath));
    if (repairWorkspace && raw.version === 2) {
      let oldCanonical: string | undefined;
      try {
        const priorPath = expandConfigPath(oldRoot as string, { configDir: path.dirname(current.configPath), userHome: homedir(), nodePath: current.nodePath });
        try { oldCanonical = await realpath(priorPath); } catch { oldCanonical = priorPath; }
      } catch { /* Invalid old path references are repairable; they never preserve the prior binding. */ }
      const sameRoot = oldCanonical !== undefined && (process.platform === 'win32' ? oldCanonical.toLowerCase() === repairWorkspace.root.toLowerCase() : oldCanonical === repairWorkspace.root);
      const workspace = raw.workspaces.find((w): w is Exclude<WorkspaceInput, string> => typeof w !== 'string' && w.id === repairWorkspace.id)!;
      workspace.uid = sameRoot && !repairWorkspace.newIdentity ? current.workspaces.find(w => w.id === repairWorkspace.id)!.uid : randomUUID();
    }
    await edit(raw, current);
    const validated = await validateConfig(raw, current.configPath);
    const bytes = Buffer.from(serializeConfig(raw, format, { originalText }));
    const temporaryPath = path.join(path.dirname(fullPath), '.webcodex-write-config-' + randomUUID());
    const temporaryFile = await open(temporaryPath, 'wx', 0o600);
    try {
      temporary = { path: temporaryPath, info: await temporaryFile.stat({ bigint: true }) };
      await protectConfigFile(temporaryPath);
      const privateInfo = await lstat(temporaryPath, { bigint: true });
      if (!privateInfo.isFile() || privateInfo.nlink !== 1n || !sameFile(temporary.info, privateInfo)) throw new AppError('CONFIG_CONFLICT', 'Temporary configuration file changed before it could be written.');
      await temporaryFile.writeFile(bytes);
      await temporaryFile.sync();
    } finally { await temporaryFile.close(); }
    const latest = await snapshot(fullPath);
    if (!sameFile(original.info, latest.info) || original.sha256 !== latest.sha256) throw new AppError('CONFIG_CONFLICT', 'Configuration changed during the edit. No changes were written.');
    await noLinks(path.dirname(fullPath));
    const temporaryInfo = await lstat(temporaryPath, { bigint: true });
    if (!temporaryInfo.isFile() || temporaryInfo.nlink !== 1n || !sameFile(temporary.info, temporaryInfo)) throw new AppError('CONFIG_CONFLICT', 'Temporary configuration file changed unexpectedly.');
    await rename(temporaryPath, fullPath);
    temporary = undefined;
    return { ok: true, restart_required: true, sha256: digest(bytes), ...publicConfig(validated) };
  } finally {
    try { if (temporary) await removeOwned(temporary.path, temporary.info); }
    finally { await lock.close(); await removeOwned(lockPath, lockInfo); }
  }
}

export async function showConfig(configPath: string) { return { ok: true, ...publicConfig(await loadConfig(configPath)) }; }

/** Clear only the historical enabled flag; no experiment can be started here. */
export async function disableActionsProbe(configPath: string) {
  return editConfig(configPath, (raw, current) => {
    if (raw.version !== 2 || !current.actionsProbe) throw new AppError('CONFIG_MIGRATION_REQUIRED', 'Actions probe management requires a version 2 configuration.');
    raw.actionsProbe = { ...(raw.actionsProbe as Record<string, unknown> | undefined), enabled: false };
  });
}

export async function workspaceHealthReport(configPath: string) {
  const config = await loadConfig(configPath, {workspaceDiagnostics:true});
  return { ok:true, config:config.configPath, checked_at:new Date().toISOString(), identity_scope:'directory checks only; running workspace_health also checks the state binding', workspaces:publicConfig(config).workspaces };
}
export async function setWorkspaceEnabled(configPath: string, id: string, enabled: boolean) {
  return editConfigLocked(configPath, () => {}, undefined, false, undefined, { id, enabled });
}

async function authorizedWorkspaceRoot(input: { id: string; root: string; worktree?:boolean }): Promise<string> {
  if (!idPattern.test(input.id)) throw new AppError('CONFIG_ERROR', 'Workspace ID must contain 1–64 letters, digits, underscores, or hyphens.');
  if (!path.isAbsolute(input.root) || /[\x00-\x1f\x7f]/.test(input.root) || input.root.replace(/\\/g, '/').split('/').some(p => p === '..')) throw new AppError('CONFIG_PATH_DENIED', 'Workspace root must be an explicit absolute directory path without parent traversal.');
  await noLinks(input.root);
  if (!(await lstat(input.root)).isDirectory()) throw new AppError('CONFIG_PATH_DENIED', 'Workspace root must be an existing real directory.');
  const root = await realpath(input.root);
  if (!input.worktree && root.replace(/\\/g, '/').split('/').some(isProtectedName)) throw new AppError('CONFIG_PATH_DENIED', 'Protected service or credential directories cannot be authorized as workspaces.');
  return root;
}

function checkWorkspaceRoot(current: AppConfig, root: string, exceptId?: string, worktree?:WorktreeAuthorization) {
  if (current.workspaces.some(w => w.id !== exceptId && contains(w.root, root) && contains(root, w.root))) throw new AppError('WORKSPACE_EXISTS', 'Workspace root is already configured.');
  if (contains(current.stateDir, root) || contains(current.configPath, root) || current.toolsDir && contains(current.toolsDir, root)) throw new AppError('CONFIG_PATH_DENIED', 'Service configuration, tools and state cannot be authorized as workspaces.');
  try {assertWorkspaceRoot(current,{id:exceptId??'candidate',name:'candidate',root,readOnly:false,...(worktree?{worktree}:{})});}
  catch(error){if(error instanceof AppError&&error.code==='PATH_DENIED')throw new AppError('CONFIG_PATH_DENIED','Protected directories cannot be authorized as workspaces.');throw error;}
}

export async function addWorkspace(configPath: string, input: { id: string; root: string; name?: string; readOnly?: boolean; worktree?:boolean }) {
  const root = await authorizedWorkspaceRoot(input);
  const worktree=input.worktree?detectLinkedWorktree(root):undefined;
  return editConfig(configPath, (raw, current) => {
    if(worktree&&raw.version!==2)throw new AppError('CONFIG_MIGRATION_REQUIRED','Linked worktree authorization requires version 2 configuration.');
    if (current.workspaces.some(w => w.id === input.id)) throw new AppError('WORKSPACE_EXISTS', 'Workspace ID is already configured.');
    checkWorkspaceRoot(current, root,undefined,worktree);
    raw.workspaces.push({ id: input.id, ...(raw.version === 2 ? { uid: randomUUID() } : {}), name: input.name ?? (path.basename(root) || input.id), root, readOnly: input.readOnly ?? false,...(worktree?{worktree}:{}) });
  });
}

/** Explicit local repair. A changed canonical root receives a new UID and therefore a new state binding. */
export async function rebindWorkspace(configPath: string, input: { id: string; root: string; name?: string; readOnly?: boolean; worktree?:boolean; newIdentity?:boolean }) {
  const root = await authorizedWorkspaceRoot(input);
  const worktree=input.worktree?detectLinkedWorktree(root):undefined;
  return editConfigLocked(configPath, (raw, current) => {
    if(worktree&&raw.version!==2)throw new AppError('CONFIG_MIGRATION_REQUIRED','Linked worktree authorization requires version 2 configuration.');
    checkWorkspaceRoot(current, root, input.id,worktree);
    const workspace = raw.workspaces.find((w): w is Exclude<WorkspaceInput, string> => typeof w !== 'string' && w.id === input.id)!;
    if (input.name !== undefined) workspace.name = input.name;
    if (input.readOnly !== undefined) workspace.readOnly = input.readOnly;
  }, undefined, false, { id: input.id, root, readOnly: input.readOnly, newIdentity: input.newIdentity,...(worktree?{worktree}:{}) });
}

export async function renameDevice(configPath: string, name: string) {
  return editConfig(configPath, raw => {
    if (raw.version !== 2 || !raw.device) throw new AppError('CONFIG_MIGRATION_REQUIRED', 'Device naming requires a version 2 unified configuration.');
    raw.device.name = name;
  });
}

export async function removeWorkspace(configPath: string, id: string) {
  return editConfig(configPath, (raw, current) => {
    const index = current.workspaces.findIndex(w => w.id === id);
    if (index === -1) throw new AppError('WORKSPACE_NOT_FOUND', 'Workspace ID is not configured.');
    if (raw.workspaces.length === 1) throw new AppError('LAST_WORKSPACE', 'At least one workspace must remain configured.');
    raw.workspaces.splice(index, 1);
  });
}

export async function setExecutionMode(configPath: string, mode: string) {
  if (mode !== 'disabled' && mode !== 'trusted-host') throw new AppError('CONFIG_ERROR', 'Execution mode must be disabled or trusted-host. trusted-host runs with the local owner permissions and is not an OS sandbox.');
  return editConfig(configPath, raw => { raw.execution.mode = mode; });
}

export async function addExecutable(configPath: string, input: { alias: string; command: string; args: string[] }) {
  if (['__proto__', 'prototype', 'constructor'].includes(input.alias)) throw new AppError('CONFIG_ERROR', 'The executable alias is reserved and unsupported.');
  if (!idPattern.test(input.alias)) throw new AppError('CONFIG_ERROR', 'Executable alias must contain 1–64 letters, digits, underscores, or hyphens.');
  if (!path.isAbsolute(input.command) || input.command.includes('\0') || /\.(?:cmd|bat)$/i.test(input.command)) throw new AppError('CONFIG_ERROR', 'Executable must be an absolute native program path; .cmd and .bat wrappers are unsupported.');
  return editConfig(configPath, raw => {
    const aliases = raw.execution.allowedExecutables ??= {};
    if (Object.hasOwn(aliases, input.alias)) throw new AppError('EXECUTABLE_EXISTS', 'Executable alias is already configured; remove it explicitly before replacement.');
    // defineProperty prevents special names such as __proto__ from modifying the JSON object's prototype.
    Object.defineProperty(aliases, input.alias, { enumerable: true, configurable: true, writable: true, value: { command: input.command, args: input.args } });
  });
}

export async function removeExecutable(configPath: string, alias: string) {
  return editConfig(configPath, raw => {
    const aliases = raw.execution.allowedExecutables ?? {};
    if (!Object.hasOwn(aliases, alias)) throw new AppError('EXECUTABLE_NOT_FOUND', 'Executable alias is not configured.');
    delete aliases[alias];
  });
}

export async function codexStatus(configPath: string) {
  const shown = await showConfig(configPath);
  return { ok: true, config: shown.config, codex_sessions: shown.codex_sessions };
}

export async function enableCodexSessions(configPath: string, home?: string) {
  return editConfig(configPath, async (raw, current) => {
    const selected = home ?? current.codexSessions.home ?? (process.env.CODEX_HOME || path.join(homedir(), '.codex'));
    const root = await resolveCodexHome(selected);
    raw.codexSessions = { ...raw.codexSessions, enabled: true, home: root };
  });
}

export async function disableCodexSessions(configPath: string) {
  return editConfigLocked(configPath, raw => {
    if (!raw.codexSessions) raw.codexSessions = { enabled: false, home: null };
    else raw.codexSessions.enabled = false;
  }, undefined, true);
}
