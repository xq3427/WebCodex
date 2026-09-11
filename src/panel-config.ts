import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { editPanelConfig, isPublicProxyUrl, readConfigDocument, validatePanelConfigBaseline, type RawConfig } from './config-admin.js';
import { configSchema, executableDefinition, expandConfigPath, resolveCodexHome, validateConfig } from './config.js';
import { assertSafeConfigObject, serializeConfig } from './config-format.js';
import { AppError } from './errors.js';
import type { AppConfig, ExecutableConfig } from './types.js';
import { workspaceHealth } from './workspace-health.js';
import { assertWorkspaceRoot, assertWorkspaceRootBoundary } from './worktree-policy.js';
import type { WorkspaceInput } from './workspace-config.js';
import { panelFieldIssue, panelInvalid, panelSchemaIssues, safePanelDetails, type PanelIssue } from './panel-validation.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const name = z.string().min(1).max(120).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).refine(value => !['constructor', 'prototype', '__proto__'].includes(value));
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const numbers = <const T extends readonly string[]>(keys: T) => z.object(Object.fromEntries(keys.map(key => [key, integer.optional()])) as { [K in T[number]]: z.ZodOptional<z.ZodNumber> }).strict();
const limitKeys = ['readMaxBytes','fileReadMaxBytes','fileTransferMaxBytes','fileWidgetUploadMaxBytes','fileWidgetTicketTtlMs','fileWidgetCacheMaxBytes','fileWidgetChunkMaxBytes','binaryWriteMaxBytes','inlineBinaryWriteMaxBytes','writeMaxBytes','searchMaxResults','listMaxEntries'] as const;
const executionNumberKeys = ['maxConcurrent','defaultTimeoutMs','maxTimeoutMs','maxOutputBytes','defaultWaitMs','maxWaitMs','stdinMaxBytes','stdinMaxTotalBytes','stdinWriteTimeoutMs'] as const;
const workspace = z.object({ id, root: text, name: name.optional(), readOnly: z.boolean().optional(), enabled: z.boolean().optional(), onUnavailable: z.enum(['error','skip']).optional(), executionProfile: id.nullable().optional() }).strict();
const executable = z.object({ alias: id, command: text, prefix_arg_count: integer.optional() }).strict();
const sectionSchema = {
  nodePath: text,
  gitPath: text,
  rgPath: text,
  toolsDir: text,
  device: z.object({ name: name.optional() }).strict(),
  workspaces: z.array(workspace).min(1).max(32),
  execution: numbers(executionNumberKeys).extend({ mode: z.enum(['disabled','trusted-host']).optional(), commandPolicy: z.enum(['all','allowlist']).optional(), executables: z.array(executable).max(128).optional() }).strict(),
  codexSessions: z.object({ enabled: z.boolean().optional(), home: text.nullable().optional(), maxWindowsPerRequest: integer.optional(), maxRecordBytes: integer.optional() }).strict(),
  diagnostics: z.object({ enabled: z.boolean().optional(), maxEvents: integer.optional() }).strict(),
  tunnel: z.object({ enabled: z.boolean().optional(), id: z.string().max(207).optional(), proxyUrl: z.string().max(4096).refine(isPublicProxyUrl).optional(), clientPath: text.optional(), clientVersion: text.optional(), clientSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable().optional() }).strict(),
  server: z.object({ transport: z.enum(['stdio','http']).optional() }).strict(),
  http: z.object({ port: integer.optional() }).strict(),
  localPanel: z.object({ port: integer.optional() }).strict(),
  limits: numbers(limitKeys),
  binaryInputs: numbers(['chunkMaxBytes','maxSessions','maxCacheBytes','ttlMs']),
  fileImports: numbers(['maxAttempts','downloadTimeoutMs']),
  fileBatches: numbers(['maxFiles','maxTotalBytes','binaryMaxTotalBytes']),
  tasks: numbers(['maxTasksPerWorkspace','maxRevisionsPerTask','maxTrackedFiles','maxSnapshotBytes']),
  projectContext: numbers(['maxDepth','maxFileBytes','maxTotalBytes']),
  fileWidget: z.object({ mode: z.enum(['automatic','manual']).optional(), compact: z.boolean().optional(), closeAfterSend: z.boolean().optional() }).strict(),
};
const patchSchema = z.object(sectionSchema).strict().partial();
const secret = z.string().max(4096).refine(value => !/[\s\p{Cc}\p{Cf}]/u.test(value)).nullable();
const requestSchema = z.object({ expected_revision: z.string().regex(/^[a-f0-9]{64}$/), patch: patchSchema, secrets: z.object({ tunnelApiKey: secret.optional(), httpBearerToken: secret.optional() }).strict().optional() }).strict();
export type PanelConfigRequest = z.infer<typeof requestSchema>;
type WorkspacePatch = z.infer<typeof workspace>;

const messages: Record<string, string> = {
  CONFIG_ERROR: 'The configuration is invalid. Check field values, paths and related limits.',
  CONFIG_PATH_DENIED: 'A configured path is unavailable, protected or linked. Use a real permitted directory.',
  CONFIG_CONFLICT: 'The configuration changed in another editor. Reload before saving.',
  CONFIG_LOCKED: 'Another local configuration edit is running. Wait and reload before saving.',
  CONFIG_EDIT_UNSUPPORTED: 'This TOML layout cannot be safely edited while preserving comments. No changes were saved.',
  CONFIG_MIGRATION_REQUIRED: 'The settings panel requires version 2 unified configuration. Migrate this configuration locally first.',
  PANEL_CONFIG_INVALID: 'Some settings are unsupported or invalid. Check the indicated fields.',
  PANEL_EXECUTABLE_ARGS_PROTECTED: 'An executable with fixed arguments cannot change its command in the panel. Keep its command or manage this alias locally.',
  WORKTREE_AUTHORIZATION_REQUIRED: 'A new linked worktree requires explicit local registration with the workspace command.',
  WORKTREE_INVALID: 'The registered linked worktree metadata is invalid. Register the intended worktree locally.',
  PATH_DENIED: 'A workspace path is protected or linked and cannot be authorized.',
};
function safeError(error: unknown): AppError {
  if (error instanceof AppError && Object.hasOwn(messages, error.code)) return new AppError(error.code, messages[error.code], safePanelDetails(error.details));
  return new AppError('CONFIG_ERROR', messages.CONFIG_ERROR);
}
function parseRequest(input: unknown): PanelConfigRequest {
  try { assertSafeConfigObject(input); } catch { throw panelInvalid([panelFieldIssue('patch','unsupported')]); }
  const result = requestSchema.safeParse(input);
  if (!result.success) {
    throw panelInvalid(panelSchemaIssues(result.error.issues));
  }
  return result.data;
}
const pick = (source: unknown, keys: readonly string[]) => Object.fromEntries(keys.filter(key => object(source) && source[key] !== undefined).map(key => [key, (source as Record<string,unknown>)[key]]));
const rawSection = (raw: RawConfig, key: string) => object(raw[key]) ? raw[key] as Record<string,unknown> : {};
const keyPath = (input: string) => process.platform === 'win32' ? path.resolve(input).toLowerCase() : path.resolve(input);

function safeView(document: Awaited<ReturnType<typeof readConfigDocument>>, current: AppConfig) {
  const raw = document.raw;
  const values: Record<string, unknown> = {
    nodePath: raw.nodePath ?? 'auto', gitPath: raw.gitPath ?? 'auto', rgPath: raw.rgPath ?? 'auto', toolsDir: raw.toolsDir ?? '${configDir}/tools',
    device: { name: current.device!.name },
    workspaces: current.workspaces.map((entry, index) => {
      const original = raw.workspaces[index];
      return { id: entry.id, name: entry.name, root: typeof original === 'string' ? original : original.root, readOnly: entry.readOnly, enabled: entry.enabled !== false, onUnavailable: entry.onUnavailable ?? 'error', executionProfile: entry.executionProfile ?? null };
    }),
    execution: { mode: current.execution.mode, commandPolicy: current.execution.commandPolicy ?? 'allowlist', ...pick(current.execution, executionNumberKeys), executables: Object.entries(raw.execution.allowedExecutables ?? {}).map(([alias, entry]) => ({ alias, command: executableDefinition(entry).command, prefix_arg_count: executableDefinition(entry).args.length })) },
    codexSessions: { ...current.codexSessions, ...pick(raw.codexSessions, ['enabled','home']) },
    diagnostics: current.diagnostics,
    tunnel: { ...pick(current.tunnel, ['enabled','id','clientVersion','clientSha256']), proxyUrl: isPublicProxyUrl(rawSection(raw,'tunnel').proxyUrl) ? rawSection(raw,'tunnel').proxyUrl ?? '' : '', clientPath: rawSection(raw, 'tunnel').clientPath ?? 'auto' },
    server: current.server,
    http: { port: current.http.port },
    localPanel: current.localPanel,
    limits: current.limits,
    binaryInputs: current.binaryInputs ?? { chunkMaxBytes:65536,maxSessions:4,maxCacheBytes:67108864,ttlMs:900000 },
    fileImports: current.fileImports ?? { maxAttempts:3,downloadTimeoutMs:60000 },
    fileBatches: current.fileBatches,
    tasks: current.tasks,
    projectContext: current.projectContext,
    fileWidget: current.fileWidget,
  };
  return {
    ok: true as const, revision: document.revision, config_path: document.fullPath, format: document.format, version: current.version, values,
    secrets: { tunnelApiKey: Boolean(rawSection(raw, 'tunnel').apiKey), httpBearerToken: Boolean(rawSection(raw, 'http').bearerToken) },
    issues: isPublicProxyUrl(rawSection(raw,'tunnel').proxyUrl) ? [] : [{ code:'PANEL_PROXY_INVALID', field:'tunnel.proxyUrl', message:'The stored proxy URL is invalid and was hidden. Enter a plain HTTP(S) proxy origin to repair it.' }],
    read_only: { device_id: current.device!.id, state_dir: current.stateDir, execution_profiles: Object.keys(current.execution.profiles ?? {}).sort(), environment_names: Object.keys(current.execution.env ?? {}).sort(), tunnel_proxy_configured: Boolean(rawSection(raw, 'tunnel').proxyUrl), workspace_health: current.workspaces.map(entry => ({ id:entry.id,...workspaceHealth(current, entry) })) },
  };
}

async function explicitDirectory(root: string) {
  let cursor = path.parse(root).root;
  for (const part of root.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError('CONFIG_PATH_DENIED', messages.CONFIG_PATH_DENIED);
  }
  return realpath(root);
}

function directoryError(field:string,error:unknown):AppError {
  const code=error instanceof AppError ? error.code : (error as NodeJS.ErrnoException)?.code;
  const message=code==='ENOENT'||code==='ENODEV' ? 'missingDirectory'
    : ['EACCES','EPERM','EBUSY'].includes(code??'') ? 'deniedDirectory'
    : code==='PATH_DENIED' ? 'protectedDirectory'
    : ['WORKTREE_AUTHORIZATION_REQUIRED','WORKTREE_INVALID'].includes(code??'') ? 'worktree'
    : code==='CONFIG_PATH_DENIED' ? 'linkedDirectory' : 'directory';
  return panelInvalid([panelFieldIssue(field,message)],error instanceof AppError && Object.hasOwn(messages,error.code)?error.code:'CONFIG_PATH_DENIED');
}

/** Add actionable safe diagnostics before the authoritative runtime validator; this never authorizes a path. */
async function validatePanelCandidate(raw:RawConfig,fullPath:string) {
  const parsed=configSchema.safeParse(raw);
  if(!parsed.success)throw panelInvalid(panelSchemaIssues(parsed.error.issues));
  if(parsed.data.version!==2)throw new AppError('CONFIG_MIGRATION_REQUIRED',messages.CONFIG_MIGRATION_REQUIRED);
  const data=parsed.data, issues:PanelIssue[]=[];
  const add=(field:string,message:Parameters<typeof panelFieldIssue>[1])=>issues.push(panelFieldIssue(field,message));
  if(data.execution.defaultTimeoutMs>data.execution.maxTimeoutMs){add('execution.defaultTimeoutMs','timeout');add('execution.maxTimeoutMs','timeout');}
  if(data.execution.defaultWaitMs>data.execution.maxWaitMs){add('execution.defaultWaitMs','wait');add('execution.maxWaitMs','wait');}
  if(data.execution.stdinMaxBytes>data.execution.stdinMaxTotalBytes){add('execution.stdinMaxBytes','stdin');add('execution.stdinMaxTotalBytes','stdin');}
  if(data.projectContext.maxFileBytes>data.projectContext.maxTotalBytes){add('projectContext.maxFileBytes','projectBytes');add('projectContext.maxTotalBytes','projectBytes');}
  if(data.tunnel.id && !/^tunnel_[a-zA-Z0-9_-]+$/.test(data.tunnel.id) || data.tunnel.enabled && !data.tunnel.id)add('tunnel.id','tunnelId');
  if(data.tunnel.enabled&&!data.tunnel.apiKey)add('secrets.tunnelApiKey','tunnelKey');
  if(!isPublicProxyUrl(data.tunnel.proxyUrl))add('tunnel.proxyUrl','proxy');
  if(data.tunnel.clientPath!=='auto'&&!data.tunnel.clientSha256)add('tunnel.clientSha256','requiredSha256');
  if(data.server.transport==='http'&&data.http.bearerToken.length<32)add('secrets.httpBearerToken','httpToken');
  if(data.codexSessions.home==='auto'||data.codexSessions.enabled&&!data.codexSessions.home)add('codexSessions.home','codexHome');
  const context:{configDir:string;userHome:string;nodePath?:string}={configDir:path.dirname(fullPath),userHome:homedir()};
  for(const field of ['nodePath','gitPath','rgPath','toolsDir'] as const) {
    try { const value=data[field]==='auto'&&field!=='toolsDir'?data[field]:expandConfigPath(data[field],context); if(field==='nodePath')context.nodePath=value==='auto'?process.execPath:value; if(field!=='toolsDir'&&/\.(cmd|bat)$/i.test(value))add(field,'native'); }
    catch {add(field,'path');}
  }
  if(data.tunnel.clientPath!=='auto')try{if(/\.(cmd|bat)$/i.test(expandConfigPath(data.tunnel.clientPath,context)))add('tunnel.clientPath','native');}catch{add('tunnel.clientPath','path');}
  if(issues.length)throw panelInvalid(issues,'CONFIG_ERROR');
  const roots:string[]=[];
  for(const [index,entry] of data.workspaces.entries()) {
    const workspace:Exclude<typeof entry,string>=typeof entry==='string'?{root:entry,readOnly:false}:entry, field=`workspaces.${index}.root`;
    let root:string;
    try {root=expandConfigPath(workspace.root,context);}catch{throw panelInvalid([panelFieldIssue(field,'path')],'CONFIG_ERROR');}
    if(roots.includes(keyPath(root)))add(field,'duplicateRoot');
    for(let previous=0;previous<index;previous++) {
      const old=data.workspaces[previous]; if(typeof old==='string'||workspace.enabled===false||old.enabled===false||Boolean(old.readOnly)===Boolean(workspace.readOnly))continue;
      const relative=path.relative(roots[previous],keyPath(root)),reverse=path.relative(keyPath(root),roots[previous]);
      const inside=(relative:string)=>relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));
      if(inside(relative)||inside(reverse)){add(`workspaces.${index}.readOnly`,'nestedPermissions');add(`workspaces.${previous}.readOnly`,'nestedPermissions');}
    }
    roots.push(keyPath(root));
    if(workspace.executionProfile&&!Object.hasOwn(data.execution.profiles??{},workspace.executionProfile))add(`workspaces.${index}.executionProfile`,'profile');
    if(workspace.enabled!==false)try{await explicitDirectory(root);}catch(error){
      if(workspace.onUnavailable==='skip'&&['ENOENT','ENODEV','EACCES','EPERM','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))continue;
      throw directoryError(field,error);
    }
  }
  if(issues.length)throw panelInvalid(issues,'CONFIG_ERROR');
  if(data.codexSessions.home!==null) {
    let root:string;
    try{root=expandConfigPath(data.codexSessions.home,context);}catch{throw panelInvalid([panelFieldIssue('codexSessions.home','path')],'CONFIG_PATH_DENIED');}
    try {if(data.codexSessions.enabled)await explicitDirectory(root);else await resolveCodexHome(root,{allowMissing:true});}catch(error){throw directoryError('codexSessions.home',error);}
  }
  try{return await validateConfig(raw,fullPath);}catch(error){
    // The runtime validator remains final. Unknown/legacy scopes get no raw parser or filesystem text.
    throw panelInvalid([panelFieldIssue('patch','invalid')],error instanceof AppError&&Object.hasOwn(messages,error.code)?error.code:'CONFIG_ERROR');
  }
}

async function applyWorkspaces(raw: RawConfig, current: AppConfig, entries: WorkspacePatch[]) {
  const context = { configDir: path.dirname(current.configPath), userHome: homedir(), nodePath: current.nodePath };
  const seen = new Set<string>();
  const next: WorkspaceInput[] = [];
  for (const [index,item] of entries.entries()) {
    if (seen.has(item.id)) throw panelInvalid([panelFieldIssue(`workspaces.${index}.id`,'duplicateId')]);
    seen.add(item.id);
    const previousIndex = current.workspaces.findIndex(entry => entry.id === item.id);
    const previous = previousIndex >= 0 ? current.workspaces[previousIndex] : undefined;
    const original = previousIndex >= 0 ? raw.workspaces[previousIndex] : undefined;
    const originalObject = typeof original === 'string' ? { root: original } : original;
    let root:string;
    try{root=expandConfigPath(item.root, context);}catch{throw panelInvalid([panelFieldIssue(`workspaces.${index}.root`,'path')]);}
    const sameRoot = previous !== undefined && keyPath(root) === keyPath(previous.root);
    const enabled = item.enabled ?? previous?.enabled ?? true;
    // Adding or moving a root is an authorization change, even when the requested row is disabled.
    // Existing offline roots can be disabled/removed/repaired without reading their contents.
    let canonical:string;
    try{canonical=sameRoot ? previous.root : await explicitDirectory(root);}catch(error){throw directoryError(`workspaces.${index}.root`,error);}
    const row: Exclude<WorkspaceInput,string> = {
      ...(originalObject ?? {}),
      id: item.id,
      uid: sameRoot ? previous.uid : randomUUID(),
      root: item.root,
      name: item.name ?? previous?.name ?? (path.basename(canonical) || item.id),
      readOnly: item.readOnly ?? previous?.readOnly ?? false,
      enabled,
      onUnavailable: item.onUnavailable ?? previous?.onUnavailable ?? 'error',
    };
    if (!sameRoot) delete row.worktree;
    if (item.executionProfile === null) delete row.executionProfile;
    else if (item.executionProfile !== undefined) row.executionProfile = item.executionProfile;
    // Preserve the old UID only for the same canonical root; never accept identity input from the UI.
    const authorized = { ...row, id:item.id, root: canonical, name: row.name!, readOnly: row.readOnly! };
    try {
      assertWorkspaceRootBoundary(current, authorized);
      if (!sameRoot) assertWorkspaceRoot(current, { ...authorized, enabled: true });
    } catch(error){throw directoryError(`workspaces.${index}.root`,error);}
    next.push(row);
  }
  raw.workspaces = next;
}

async function applyRequest(raw: RawConfig, current: AppConfig, input: PanelConfigRequest) {
  if (raw.version !== 2) throw new AppError('CONFIG_MIGRATION_REQUIRED', messages.CONFIG_MIGRATION_REQUIRED);
  for (const [section, values] of Object.entries(input.patch)) {
    if (section === 'workspaces' || section === 'execution') continue;
    raw[section] = object(values) ? { ...rawSection(raw, section), ...values } : values;
    if (section === 'tunnel' && object(raw.tunnel) && raw.tunnel.clientSha256 === null) delete raw.tunnel.clientSha256;
  }
  if (input.patch.execution) {
    const { executables, ...settings } = input.patch.execution;
    Object.assign(raw.execution, settings);
    if (executables) {
      const next: Record<string,ExecutableConfig> = {};
      for (const [index,entry] of executables.entries()) {
        if (Object.hasOwn(next, entry.alias)) throw panelInvalid([panelFieldIssue(`execution.executables.${index}.alias`,'duplicateAlias')]);
        const existing = raw.execution.allowedExecutables?.[entry.alias];
        const previous = existing === undefined ? undefined : executableDefinition(existing);
        if (previous && previous.args.length && previous.command !== entry.command) throw new AppError('PANEL_EXECUTABLE_ARGS_PROTECTED', messages.PANEL_EXECUTABLE_ARGS_PROTECTED);
        next[entry.alias] = previous?.command === entry.command ? existing! : { command: entry.command, args: [] };
      }
      raw.execution.allowedExecutables = next;
    }
  }
  if (input.patch.workspaces) await applyWorkspaces(raw, current, input.patch.workspaces);
  if (input.secrets && Object.hasOwn(input.secrets, 'tunnelApiKey')) raw.tunnel = { ...rawSection(raw,'tunnel'), apiKey: input.secrets.tunnelApiKey ?? '' };
  if (input.secrets && Object.hasOwn(input.secrets, 'httpBearerToken')) raw.http = { ...rawSection(raw,'http'), bearerToken: input.secrets.httpBearerToken ?? '' };
}

/** Local admin only. Instances neither load StateStore nor mutate the live server's authorization. */
export class PanelConfigService {
  constructor(private readonly configPath: string) {}

  async read() {
    try {
      const document = await readConfigDocument(this.configPath);
      if (document.raw.version !== 2) throw new AppError('CONFIG_MIGRATION_REQUIRED', messages.CONFIG_MIGRATION_REQUIRED);
      return safeView(document, await validatePanelConfigBaseline(document.raw, document.fullPath));
    } catch (error) { throw safeError(error); }
  }

  async validate(input: unknown) {
    try {
      const request = parseRequest(input);
      const document = await readConfigDocument(this.configPath);
      if (document.revision !== request.expected_revision) throw new AppError('CONFIG_CONFLICT', messages.CONFIG_CONFLICT);
      const current = await validatePanelConfigBaseline(document.raw, document.fullPath);
      await applyRequest(document.raw, current, request);
      await validatePanelCandidate(document.raw, document.fullPath);
      // Detect comment-preserving TOML limitations before the user clicks Save.
      serializeConfig(document.raw, document.format, { originalText: document.originalText });
      const latest = await readConfigDocument(this.configPath);
      if (latest.revision !== document.revision) throw new AppError('CONFIG_CONFLICT', messages.CONFIG_CONFLICT);
      return { ok:true as const, valid:true as const, revision:document.revision, restart_required:true as const };
    } catch (error) { throw safeError(error); }
  }

  async save(input: unknown) {
    try {
      const request = parseRequest(input);
      let committed!: ReturnType<typeof safeView>;
      const saved = await editPanelConfig(this.configPath, async (raw, current) => {
        await applyRequest(raw, current, request);
        const validated = await validatePanelCandidate(raw, current.configPath);
        const format = path.extname(current.configPath).toLowerCase() === '.toml' ? 'toml' : 'json';
        committed = safeView({ fullPath:current.configPath,format,revision:'',originalText:'',raw }, validated);
      }, request.expected_revision);
      // A successful atomic commit remains successful even if the next read fails
      // or another local editor changes the file. Its receipt never adopts their revision.
      let currentRevision: string | undefined, readbackError: string | undefined;
      try { currentRevision = (await this.read()).revision; } catch (error) { readbackError = safeError(error).code; }
      return { ...committed, revision:saved.sha256, restart_required:true as const, saved_revision:saved.sha256,
        changed_again:currentRevision !== saved.sha256, readback_verified:currentRevision === saved.sha256,
        ...(currentRevision ? { current_revision:currentRevision } : {}), ...(readbackError ? { readback_error:readbackError } : {}) };
    } catch (error) { throw safeError(error); }
  }
}
