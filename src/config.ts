import { access, readFile, realpath, lstat, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { homedir, hostname } from 'node:os';
import { z } from 'zod';
import { AppError } from './errors.js';
import { assertSafeConfigObject, configFormatForPath, parseConfigText } from './config-format.js';
import type { AppConfig, ExecutableConfig, WorkspaceConfig } from './types.js';
import { validExecutionEnvironment } from './execution-env.js';
import { assertWorkspaceRoot, assertWorkspaceRootBoundary } from './worktree-policy.js';
import { inspectWorkspace } from './workspace-health.js';
import { workspaceDefaults } from './workspace-config.js';
import { assertCompatibleWorkspaceRoots } from './workspace-overlap.js';

const text = z.string().min(1).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const argument = z.string().refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 128 * 1024);
const executableSchema = z.union([text, z.object({ command: text, args: z.array(argument).max(256) }).strict()]);
const profileSchema = z.object({ allowedExecutables: z.record(executableSchema), env: z.record(z.string()).refine(validExecutionEnvironment).optional() }).strict();
const workspaceSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), name: z.string().min(1).max(120).refine(value => !/[\x00-\x1f\x7f]/.test(value)), root: text, readOnly: z.boolean().default(false) }).strict();
const executionSchema = z.object({ mode: z.enum(['disabled','trusted-host']).default('disabled'), allowedExecutables: z.record(executableSchema).default({}), maxConcurrent: z.number().int().min(1).max(8).default(2), maxTimeoutMs: z.number().int().min(100).max(86400000).default(600000), maxOutputBytes: z.number().int().min(1024).max(52428800).default(5242880) }).strict();
const codexSchema = z.object({ enabled: z.boolean().default(false), home: text.nullable().default(null) }).strict();
const fileWidgetSchema = z.object({ mode: z.enum(['automatic', 'manual']).default('automatic'), compact: z.boolean().default(true), closeAfterSend: z.boolean().default(true) }).strict();
const baseSchema = z.object({
  version: z.literal(1), stateDir: text,
  workspaces: z.array(workspaceSchema).min(1).max(32),
  execution: executionSchema,
  fileWidget: fileWidgetSchema.default({}),
  diagnostics: z.object({ enabled: z.boolean().default(true), maxEvents: z.number().int().min(20).max(10000).default(1000) }).strict().default({}),
  limits: z.object({ readMaxBytes: z.number().int().min(256).max(1048576).default(65536), fileReadMaxBytes: z.number().int().min(1024).max(134217728).default(16777216), fileTransferMaxBytes: z.number().int().min(1).max(7340032).optional(), fileWidgetUploadMaxBytes: z.number().int().min(1).max(536870912).optional(), fileWidgetTicketTtlMs: z.number().int().min(1000).max(1800000).optional(), fileWidgetCacheMaxBytes: z.number().int().min(1).max(268435456).optional(), fileWidgetChunkMaxBytes: z.number().int().min(4096).max(262144).optional(), writeMaxBytes: z.number().int().min(1024).max(4194304).default(1048576), searchMaxResults: z.number().int().min(1).max(1000).default(100), listMaxEntries: z.number().int().min(1).max(1000).default(200) }).strict().default({}),
  rgPath: text.default('rg'),
  http: z.object({ port: z.number().int().min(1024).max(65535).default(8765) }).strict().default({}),
  codexSessions: codexSchema.default({})
}).strict();
const secret = z.string().max(4096).refine(value => !/[\s\p{Cc}\p{Cf}]/u.test(value));
const nativeAttachmentSchema = z.object({
  enabled: z.boolean().default(false), runtimeDir: text.default('${configDir}/native-attachment'),
  browser: z.object({ engine: z.literal('chromium').default('chromium'), channel: z.enum(['msedge','chrome','chromium']).default(process.platform === 'win32' ? 'msedge' : 'chromium'), userDataDir: text.default('${configDir}/browser-profile'), executablePath: text.nullable().default(null) }).strict().default({}),
  maxFileBytes: z.number().int().min(1).max(536870912).default(67108864),
  maxQueueJobs: z.number().int().min(1).max(20).default(4),
  uploadTimeoutMs: z.number().int().min(1000).max(600000).default(180000),
  bindingTtlMs: z.number().int().min(10000).max(600000).default(300000),
}).strict();
const v2Schema = baseSchema.extend({
  version: z.literal(2),
  device: z.object({ id: z.string().uuid(), name: z.string().min(1).max(120).refine(value => !/[\x00-\x1f\x7f]/.test(value)) }).strict(),
  workspaces: z.array(z.union([text, workspaceSchema.partial({ id: true, name: true }).extend({ uid: z.string().uuid().optional(), enabled: z.boolean().optional(), onUnavailable: z.enum(['error', 'skip']).optional(), executionProfile: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(), worktree: z.object({ gitDir:text, commonDir:text }).strict().optional() })])).min(1).max(32),
  stateDir: text.default('${configDir}/state'), toolsDir: text.default('${configDir}/tools'), nodePath: text.default('auto'), gitPath: text.default('auto'), rgPath: text.default('auto'),
  tunnel: z.object({ enabled: z.boolean().default(false), id: z.string().max(207).default(''), apiKey: secret.default(''), proxyUrl: secret.default(''), clientPath: text.default('auto'), clientVersion: z.string().regex(/^(?:auto|v\d+\.\d+\.\d+)$/).default('auto'), clientSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }).strict().default({}),
  server: z.object({ transport: z.enum(['stdio', 'http']).default('stdio') }).strict().default({}),
  http: z.object({ port: z.number().int().min(1024).max(65535).default(8765), bearerToken: secret.default('') }).strict().default({}),
  // Historical experiment only: accepting this section never activates it.
  // Keep it optional so ordinary reads, init and exports do not reintroduce it.
  actionsProbe: z.object({ enabled: z.boolean().default(false), apiKey: secret.default(''), publicBaseUrl: z.string().max(2048).default(''), port: z.number().int().min(1024).max(65535).default(8766), quickTunnel: z.object({ clientPath: text.default('auto'), startupTimeoutMs: z.number().int().min(10000).max(180000).default(60000), proxyUrl: secret.optional() }).strict().default({}) }).strict().optional(),
  localPanel: z.object({ port: z.number().int().min(1024).max(65535).default(8767) }).strict().default({}),
  nativeAttachment: nativeAttachmentSchema.optional(),
  execution: executionSchema.extend({ profiles: z.record(profileSchema).refine(value => Object.keys(value).length <= 32).optional(), defaultTimeoutMs: z.number().int().min(100).max(86400000).default(60000), env:z.record(z.string()).refine(validExecutionEnvironment).optional(), defaultWaitMs:z.number().int().min(0).max(20000).default(1000),maxWaitMs:z.number().int().min(1).max(20000).default(20000),stdinMaxBytes:z.number().int().min(1).max(1048576).default(65536),stdinMaxTotalBytes:z.number().int().min(1).max(16777216).default(1048576),stdinWriteTimeoutMs:z.number().int().min(100).max(20000).default(5000) }),
  fileBatches:z.object({maxFiles:z.number().int().min(1).max(100).default(20),maxTotalBytes:z.number().int().min(1024).max(33554432).default(4194304)}).strict().default({}),
  tasks:z.object({maxTasksPerWorkspace:z.number().int().min(1).max(10000).default(100),maxRevisionsPerTask:z.number().int().min(1).max(10000).default(100),maxTrackedFiles:z.number().int().min(1).max(100).default(20),maxSnapshotBytes:z.number().int().min(1024).max(134217728).default(16777216)}).strict().default({}),
  projectContext:z.object({maxDepth:z.number().int().min(1).max(128).default(32),maxFileBytes:z.number().int().min(1024).max(1048576).default(65536),maxTotalBytes:z.number().int().min(1024).max(4194304).default(262144)}).strict().default({}),
  codexSessions: codexSchema.extend({ maxWindowsPerRequest: z.number().int().min(1).max(8).default(4), maxRecordBytes: z.number().int().min(65536).max(1048576).default(1048576) }).default({}),
}).strict();
const schema = z.discriminatedUnion('version', [baseSchema, v2Schema]);
const invalid = () => new AppError('CONFIG_ERROR', 'Configuration validation failed. Check required fields, paths, types and supported values; sensitive values are not included in diagnostics.');

/** Retained for existing v1 integrations. New installations use defaultUnifiedConfig. */
export function defaultConfig(root: string, configPath: string) {
  return {
    version: 1 as const, stateDir: path.resolve(path.dirname(configPath), 'state'),
    workspaces: [{ id: 'default', name: path.basename(root) || 'Workspace', root: path.resolve(root), readOnly: false }],
    execution: { mode: 'disabled' as const, allowedExecutables: { node: process.execPath }, maxConcurrent: 2, maxTimeoutMs: 600000, maxOutputBytes: 5242880 },
    fileWidget: { mode: 'automatic' as const, compact: true, closeAfterSend: true },
    diagnostics: { enabled: true, maxEvents: 1000 },
    limits: { readMaxBytes: 65536, fileReadMaxBytes: 16777216, writeMaxBytes: 1048576, searchMaxResults: 100, listMaxEntries: 200 },
    rgPath: 'rg', http: { port: 8765 }, codexSessions: { enabled: false, home: null as string | null }
  };
}

/** Raw portable v2 document. Nothing is read from environment credential sources or written here. */
export function defaultUnifiedConfig(root: string, configPath: string, options: { deviceId?: string; deviceName?: string; workspaceUid?: string } = {}) {
  const configDir = path.resolve(path.dirname(configPath));
  const relative = path.relative(configDir, path.resolve(root));
  return {
    ...defaultConfig(root, configPath), version: 2 as const,
    device: { id: options.deviceId ?? randomUUID(), name: options.deviceName ?? hostname() },
    stateDir: '${configDir}/state', toolsDir: '${configDir}/tools', nodePath: 'auto', gitPath: 'auto', rgPath: 'auto',
    workspaces: [{ id: 'default', uid: options.workspaceUid ?? randomUUID(), name: path.basename(root) || 'Workspace', root: path.isAbsolute(relative) ? path.resolve(root) : relative.split(path.sep).join('/') || '.', readOnly: false }],
    execution: { ...defaultConfig(root, configPath).execution, defaultTimeoutMs: 60000, defaultWaitMs:1000,maxWaitMs:20000,stdinMaxBytes:65536,stdinMaxTotalBytes:1048576,stdinWriteTimeoutMs:5000, allowedExecutables: { node: { command: '${nodePath}', args: [] as string[] } } },
    fileBatches:{maxFiles:20,maxTotalBytes:4194304},
    tasks:{maxTasksPerWorkspace:100,maxRevisionsPerTask:100,maxTrackedFiles:20,maxSnapshotBytes:16777216},
    projectContext:{maxDepth:32,maxFileBytes:65536,maxTotalBytes:262144},
    tunnel: { enabled: false, id: '', apiKey: '', proxyUrl: '', clientPath: 'auto', clientVersion: 'auto' },
    server: { transport: 'stdio' as const }, http: { port: 8765, bearerToken: '' },
    localPanel: { port: 8767 },
    codexSessions: { enabled: false, home: null as string | null, maxWindowsPerRequest: 4, maxRecordBytes: 1048576 }
  };
}

async function configCandidate(candidate: string): Promise<string | undefined> {
  try { if (!(await stat(candidate)).isFile()) throw invalid(); return path.resolve(candidate); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw invalid(); }
}

/** Resolve an explicit selection identically for initialization and later loading, even before it exists. */
export function resolveConfigSelectionPath(selected: string, options: { cwd?: string; userHome?: string } = {}): string {
  if (!selected.trim() || /[\x00-\x1f\x7f]/.test(selected)) throw invalid();
  const userHome = options.userHome ?? homedir();
  const expanded = selected === '~' ? userHome : /^~[\\/]/.test(selected) ? path.join(userHome, selected.slice(2)) : selected;
  if (expanded === selected && selected.startsWith('~')) throw invalid();
  const resolved = path.resolve(options.cwd ?? process.cwd(), expanded);
  configFormatForPath(resolved);
  return resolved;
}

/** Select exactly one file. Explicit selections and ambiguity never fall through to another level. */
export async function discoverConfigPath(explicit?: string, options: { cwd?: string; env?: NodeJS.ProcessEnv; userHome?: string } = {}): Promise<string> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const selected = explicit !== undefined ? explicit : env.WEBCODEX_CONFIG;
  if (selected !== undefined) {
    const resolved = resolveConfigSelectionPath(selected, { cwd, userHome });
    if (await configCandidate(resolved)) return resolved;
    throw new AppError('CONFIG_NOT_FOUND', 'The explicitly selected configuration file does not exist.');
  }
  const userDirectory = process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local'), 'WebCodex')
    : process.platform === 'darwin' ? path.join(userHome, 'Library', 'Application Support', 'WebCodex')
      : path.join(env.XDG_CONFIG_HOME || path.join(userHome, '.config'), 'webcodex');
  for (const directory of [path.join(cwd, '.webcodex'), userDirectory]) {
    const found = (await Promise.all(['config.toml', 'config.json'].map(file => configCandidate(path.join(directory, file))))).filter((file): file is string => file !== undefined);
    if (found.length > 1) throw new AppError('CONFIG_AMBIGUOUS', 'Both config.toml and config.json exist at the selected discovery level. Select one with --config.');
    if (found.length === 1) return found[0];
  }
  throw new AppError('CONFIG_NOT_FOUND', 'No WebCodex configuration was found. Run init or select a file with --config.');
}

export async function loadConfig(configPath: string, options: { workspaceDiagnostics?: boolean } = {}): Promise<AppConfig> {
  let fullPath: string;
  try {
    const selected = path.resolve(configPath);
    await noDirectoryLinks(path.dirname(selected));
    const metadata = await lstat(selected);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 1048576) throw invalid();
    fullPath = await realpath(selected);
  } catch { throw new AppError('CONFIG_ERROR','Cannot resolve configuration as a regular file of at most 1 MiB without links.'); }
  const format = configFormatForPath(configPath);
  let source: string;
  try { source = await readFile(fullPath, 'utf8'); } catch { throw new AppError('CONFIG_ERROR', 'Cannot read the selected configuration file.'); }
  return validateConfig(parseConfigText(source, format), fullPath, options);
}

type PathContext = { configDir: string; userHome: string; nodePath?: string };
/** References are substitutions only; no shell or process is ever invoked. Secrets never call this function. */
export function expandConfigPath(value: string, context: PathContext): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw invalid();
  let expanded = value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    if (name !== 'userHome' && name !== 'configDir' && name !== 'nodePath') throw invalid();
    const replacement = context[name]; if (!replacement) throw invalid(); return replacement;
  });
  if (expanded.includes('${')) throw invalid();
  if (expanded === '~') expanded = context.userHome;
  else if (/^~[\\/]/.test(expanded)) expanded = path.join(context.userHome, expanded.slice(2));
  else if (expanded.startsWith('~')) throw invalid();
  return path.resolve(context.configDir, expanded);
}

function nativePath(command: string): string {
  if (!path.isAbsolute(command) || /[\x00-\x1f\x7f]/.test(command) || /\.(cmd|bat)$/i.test(command)) throw invalid();
  return command;
}

async function discoverExecutable(name: string): Promise<string> {
  const suffixes = process.platform === 'win32' ? ['.exe', '.com', ''] : [''];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    // Relative/empty PATH entries depend on cwd and are unsuitable for stable tool discovery.
    if (!path.isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory)) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(directory, name + suffix);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return nativePath(await realpath(candidate));
      } catch { /* Optional tool: continue through PATH without executing a shell. */ }
    }
  }
  return name;
}

/** Validate an in-memory edit before it is written, resolving paths relative to the selected config. */
export async function validateConfig(input: unknown, fullPath: string, options: { workspaceDiagnostics?: boolean } = {}): Promise<AppConfig> {
  assertSafeConfigObject(input);
  const parsed = schema.safeParse(input);
  // Schema errors may contain unknown keys or data-derived values. Never return parser issue objects.
  if (!parsed.success) throw invalid();
  const data = parsed.data;
  const pathContext: PathContext = { configDir: path.dirname(path.resolve(fullPath)), userHome: homedir() };
  if (data.version === 2) {
    data.nodePath = nativePath(data.nodePath === 'auto' ? process.execPath : expandConfigPath(data.nodePath, pathContext));
    pathContext.nodePath = data.nodePath;
    data.gitPath = data.gitPath === 'auto' ? await discoverExecutable('git') : nativePath(expandConfigPath(data.gitPath, pathContext));
    data.rgPath = data.rgPath === 'auto' ? await discoverExecutable('rg') : nativePath(expandConfigPath(data.rgPath, pathContext));
    data.toolsDir = await canonicalForCreateSafe(expandConfigPath(data.toolsDir, pathContext));
    if (data.nativeAttachment) {
      const native = data.nativeAttachment;
      native.runtimeDir = expandConfigPath(native.runtimeDir, pathContext);
      native.browser.userDataDir = expandConfigPath(native.browser.userDataDir, pathContext);
      if (native.browser.executablePath) native.browser.executablePath = nativePath(expandConfigPath(native.browser.executablePath, pathContext));
      // These must be dedicated child directories, never an existing config/state root.
      const inside = (root:string, target:string) => { const rel=path.relative(root,target); return !rel || !path.isAbsolute(rel) && rel!=='..' && !rel.startsWith('..'+path.sep); };
      for (const root of [native.runtimeDir, native.browser.userDataDir]) {
        if ([pathContext.configDir, pathContext.userHome, expandConfigPath(data.stateDir,pathContext)].some(target=>inside(root,target))) throw invalid();
        await resolveCodexHome(root, {allowMissing:true});
      }
      if (inside(native.runtimeDir,native.browser.userDataDir) || inside(native.browser.userDataDir,native.runtimeDir)) throw invalid();
    }
    if (data.execution.defaultTimeoutMs > data.execution.maxTimeoutMs) throw invalid();
    if(data.execution.defaultWaitMs>data.execution.maxWaitMs||data.projectContext.maxFileBytes>data.projectContext.maxTotalBytes)throw invalid();
    if(data.execution.stdinMaxBytes>data.execution.stdinMaxTotalBytes)throw invalid();
    if (data.tunnel.id && !/^tunnel_[a-zA-Z0-9_-]+$/.test(data.tunnel.id)) throw invalid();
    if (data.tunnel.enabled && (!data.tunnel.id || !data.tunnel.apiKey.trim())) throw invalid();
    if (data.tunnel.proxyUrl) {
      try { const url = new URL(data.tunnel.proxyUrl); if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw invalid(); }
      catch { throw invalid(); }
    }
    if (data.tunnel.clientPath !== 'auto') {
      data.tunnel.clientPath = nativePath(expandConfigPath(data.tunnel.clientPath, pathContext));
      if (!data.tunnel.clientSha256) throw invalid();
    }
    if (data.server.transport === 'http' && data.http.bearerToken.length < 32) throw invalid();
    if (data.codexSessions.home === 'auto') throw new AppError('CONFIG_ERROR', 'Codex home must be a saved directory path; use the local codex enable command for first-time home discovery.');
    data.device.id = data.device.id.toLowerCase();
  }
  const workspaces: WorkspaceConfig[] = [];
  try {
    for (const entry of data.workspaces) {
      const w = typeof entry === 'string' ? { root: entry } : entry;
      const root = data.version === 2 ? expandConfigPath(w.root, pathContext) : path.resolve(pathContext.configDir, w.root);
      let canonical = root;
      if (!('enabled' in w && w.enabled === false)) {
        try {
          const info = await lstat(root);
          if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
          if (data.version === 2) await noDirectoryLinks(root);
          canonical = await realpath(root);
        } catch (error) {
          if (!options.workspaceDiagnostics && (!('onUnavailable' in w && w.onUnavailable === 'skip') || !['ENOENT', 'ENODEV', 'EACCES', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? ''))) throw error;
        }
      }
      const uid = 'uid' in w && w.uid !== undefined ? String(w.uid).toLowerCase() : undefined;
      const worktree = 'worktree' in w && w.worktree ? { gitDir:expandConfigPath(w.worktree.gitDir,pathContext), commonDir:expandConfigPath(w.worktree.commonDir,pathContext) } : undefined;
      const defaults: WorkspaceConfig = data.version === 2 ? workspaceDefaults(data.device.id, canonical) : { id: 'default', name: 'Workspace', readOnly: false, root: canonical };
      workspaces.push({
        ...defaults, ...w,
        id: ('id' in w ? w.id : undefined) ?? defaults.id,
        name: ('name' in w ? w.name : undefined) ?? defaults.name,
        ...(data.version === 2 ? { uid: uid ?? defaults.uid } : {}),
        ...(worktree ? {worktree} : {}), root: canonical
      });
    }
  } catch { throw new AppError('CONFIG_ERROR', 'Workspace roots must exist as real directories without links.'); }
  if (new Set(workspaces.map(w => w.id)).size !== workspaces.length) throw new AppError('CONFIG_ERROR', 'Workspace IDs must be unique.');
  if (data.version === 2 && new Set(workspaces.map(w => w.uid)).size !== workspaces.length) throw new AppError('CONFIG_ERROR', 'Workspace UIDs must be unique.');
  if (data.version === 2 && new Set(workspaces.map(w => process.platform === 'win32' ? w.root.toLowerCase() : w.root)).size !== workspaces.length) throw new AppError('CONFIG_ERROR', 'Workspace roots must be unique.');
  if (data.version === 2) assertCompatibleWorkspaceRoots(workspaces);
  const executableGroups = [data.execution.allowedExecutables];
  if (data.version === 2) {
    for (const [name, profile] of Object.entries(data.execution.profiles ?? {})) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw invalid();
      executableGroups.push(profile.allowedExecutables);
    }
    for (const workspace of workspaces) if (workspace.executionProfile && !Object.hasOwn(data.execution.profiles ?? {}, workspace.executionProfile)) throw new AppError('CONFIG_ERROR', 'A workspace references an undefined execution profile.');
  }
  for (const executables of executableGroups) for (const [alias, exe] of Object.entries(executables)) {
      const definition = executableDefinition(exe);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(alias)) throw invalid();
      const command = nativePath(data.version === 2 ? expandConfigPath(definition.command, pathContext) : definition.command);
      executables[alias] = typeof exe === 'string' ? command : { ...definition, command };
  }
  if (data.codexSessions.enabled && data.codexSessions.home === null) throw new AppError('CONFIG_ERROR', 'Codex session access requires an explicitly configured home directory.');
  let codexHome: string | null = null;
  try {
    if (data.codexSessions.home !== null) codexHome = await resolveCodexHome(data.version === 2 ? expandConfigPath(data.codexSessions.home, pathContext) : data.codexSessions.home, { allowMissing: !data.codexSessions.enabled });
  } catch { throw new AppError('CONFIG_PATH_DENIED', 'The configured Codex home must be a real directory without links; enabled access requires it to exist.'); }
  const state = data.version === 2 ? expandConfigPath(data.stateDir, pathContext) : path.resolve(pathContext.configDir, data.stateDir);
  const result: AppConfig = { ...data, workspaces, codexSessions: { ...data.codexSessions, home: codexHome }, stateDir: await canonicalForCreateSafe(state), configPath: path.resolve(fullPath) };
  for (const workspace of workspaces) {
    assertWorkspaceRootBoundary(result, workspace);
    if (workspace.enabled === false || options.workspaceDiagnostics) continue;
    if (workspace.onUnavailable === 'skip') {
      const inspected = inspectWorkspace(result, workspace);
      if (inspected.health.status === 'missing' || inspected.health.status === 'inaccessible') continue;
    }
    assertWorkspaceRoot(result,workspace);
  }
  return result;
}

async function noDirectoryLinks(absolute: string): Promise<void> {
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component); const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw invalid();
  }
}

/** Inspect directory metadata only; never read the Codex home's credentials or configuration. */
export async function resolveCodexHome(home: string, options: { allowMissing?: boolean } = {}): Promise<string> {
  if (!path.isAbsolute(home) || /[\x00-\x1f\x7f]/.test(home) || home.replace(/\\/g, '/').split('/').some(part => part === '..')) throw new AppError('CONFIG_PATH_DENIED', 'Codex home must be an explicit absolute directory without parent traversal.');
  const absolute = path.resolve(home);
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (options.allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return canonicalForCreateSafe(absolute);
      throw new AppError('CONFIG_PATH_DENIED', 'The configured Codex home does not exist or is inaccessible.');
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new AppError('CONFIG_PATH_DENIED', 'Codex home must be a real directory and cannot traverse links or junctions.');
  }
  return realpath(absolute);
}
export function executableDefinition(executable: ExecutableConfig): { command: string; args: string[] } {
  return typeof executable === 'string' ? { command: executable, args: [] } : { command: executable.command, args: [...executable.args] };
}
async function canonicalForCreateSafe(target: string): Promise<string> {
  try { return await canonicalForCreate(target); } catch { throw new AppError('CONFIG_ERROR', 'A configured runtime directory cannot be resolved.'); }
}
async function canonicalForCreate(target: string): Promise<string> {
  try { if (!(await stat(target)).isDirectory()) throw invalid(); return await realpath(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = path.dirname(target); if (parent === target) throw error; return path.join(await canonicalForCreate(parent), path.basename(target)); }
}
