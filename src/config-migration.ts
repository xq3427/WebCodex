import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { access, link, lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';
import { defaultUnifiedConfig, validateConfig } from './config.js';
import { configFormatForPath, parseConfigText, serializeConfig } from './config-format.js';
import { protectConfigFile } from './config-permissions.js';
import type { AppConfig } from './types.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const sameFile = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && a.birthtimeNs === b.birthtimeNs &&
  (a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0n || b.dev === 0n)));
interface Snapshot { file: string; bytes: Buffer; info: BigIntStats; limit: number }

async function exists(file: string) { try { await access(file); return true; } catch (error) { if (missing(error)) return false; throw error; } }

async function canonicalDirectory(directory: string, create = false) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!create || !missing(error)) throw error;
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(current, await realpath(current)) !== '') throw new AppError('CONFIG_PATH_DENIED', 'Configuration directories must be canonical directories without links or junctions.');
  }
}

async function safeSnapshot(file: string, limit = 1024 * 1024): Promise<Snapshot> {
  await canonicalDirectory(path.dirname(file));
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)) throw new AppError('MIGRATION_SOURCE_INVALID', 'A migration source must be a bounded regular file without links.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await handle.stat({ bigint: true });
    if (!sameFile(initial, before) || initial.size !== before.size || initial.nlink !== 1n || !initial.isFile()) throw new AppError('CONFIG_CONFLICT', 'A migration source changed during reading.');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) { const result = await handle.read(buffer, size, buffer.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
    const after = await handle.stat({ bigint: true });
    const final = await lstat(file, { bigint: true });
    if (size > limit || BigInt(size) !== after.size || initial.mtimeNs !== after.mtimeNs || initial.ctimeNs !== after.ctimeNs || !sameFile(initial, after) || !sameFile(initial, final) || final.size !== after.size || final.mtimeNs !== after.mtimeNs || final.ctimeNs !== after.ctimeNs || final.nlink !== 1n || final.isSymbolicLink()) throw new AppError('CONFIG_CONFLICT', 'A migration source changed during reading.');
    return { file, bytes: buffer.subarray(0, size), info: after, limit };
  } finally { await handle.close(); }
}

async function unchanged(snapshot: Snapshot) {
  const latest = await safeSnapshot(snapshot.file, snapshot.limit);
  if (!sameFile(snapshot.info, latest.info) || snapshot.info.mtimeNs !== latest.info.mtimeNs || snapshot.info.ctimeNs !== latest.info.ctimeNs || sha(snapshot.bytes) !== sha(latest.bytes)) throw new AppError('CONFIG_CONFLICT', 'A migration source changed. No configuration was published.');
}

async function removeOwned(file: string, info: BigIntStats) {
  try { const current = await lstat(file, { bigint: true }); if (!current.isSymbolicLink() && sameFile(info, current)) await unlink(file); }
  catch (error) { if (!missing(error)) throw error; }
}

/** Apply restrictive permissions while the file is still empty, before writing any secret. */
async function privateContents(file: string, bytes: Buffer): Promise<BigIntStats> {
  const handle = await open(file, 'wx', 0o600);
  const info = await handle.stat({ bigint: true });
  let complete = false;
  try {
    await protectConfigFile(file);
    const current = await lstat(file, { bigint: true });
    if (!sameFile(info, current) || current.nlink !== 1n || current.isSymbolicLink()) throw new AppError('CONFIG_CONFLICT', 'Temporary configuration changed before writing.');
    await handle.writeFile(bytes); await handle.sync();
    complete = true;
    return await handle.stat({ bigint: true });
  } finally {
    await handle.close();
    if (!complete) await removeOwned(file, info);
  }
}

function legacyConnection(bytes: Buffer) {
  // Accept only one static literal for each known argument. Never execute imported PowerShell.
  const text = bytes.toString('utf8').split(/\r?\n/).filter(line => !line.trimStart().startsWith('#')).join('\n');
  const get = (name: string) => {
    const matches = [...text.matchAll(new RegExp(`-${name}\\s+(['"])([^'"\\r\\n]+)\\1`, 'gi'))];
    if (matches.length > 1 || matches.some(match => /[$`]/.test(match[2]))) throw new AppError('MIGRATION_CONNECTION_AMBIGUOUS', 'Legacy connection parameters are dynamic or ambiguous. Use a supported static connection file.');
    const mentions = [...text.matchAll(new RegExp(`-${name}\\b`, 'gi'))].length;
    if (name === 'ProxyUrl' && mentions === 1 && matches.length === 0) {
      // The generated legacy launcher declares one literal parameter default and
      // forwards it once. Reject all other references/assignments and expressions.
      const forwarded = [...text.matchAll(/-ProxyUrl\s+\$ProxyUrl(?=\s|$)/gi)];
      const defaults = [...text.matchAll(/\[string\]\s*\$ProxyUrl\s*=\s*(['"])([^'"\r\n]*)\1(?=\s*[,\)])/gi)];
      const references = [...text.matchAll(/\$ProxyUrl\b/gi)];
      if (/^\s*(?:\[CmdletBinding\s*\(\s*\)\]\s*)?param\s*\(/i.test(text) && forwarded.length === 1 && defaults.length === 1 && references.length === 2 && !/[$`]/.test(defaults[0][2])) return defaults[0][2];
    }
    if (mentions && matches.length !== mentions) throw new AppError('MIGRATION_CONNECTION_AMBIGUOUS', 'A legacy connection parameter could not be read as a static literal.');
    return matches[0]?.[2] ?? '';
  };
  return { id: get('TunnelId'), proxyUrl: get('ProxyUrl') };
}

async function existingIdentities(config: AppConfig) {
  const file = path.join(config.stateDir, 'webcodex.sqlite');
  if (!(await exists(file))) return { deviceId: undefined, workspaces: new Map<string, string>() };
  await canonicalDirectory(config.stateDir);
  const original = await lstat(file, { bigint: true });
  for (const candidate of [file, file + '-wal', file + '-shm']) {
    if (!(await exists(candidate))) continue;
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new AppError('MIGRATION_STATE_INVALID', 'State metadata must be regular local files.');
  }
  if (await exists(file + '-wal') && !(await exists(file + '-shm'))) throw new AppError('MIGRATION_STATE_BUSY', 'State metadata cannot be read without creating a sidecar. Stop the service cleanly before migrating.');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=500; BEGIN;');
    const currentFile = await lstat(file, { bigint: true });
    if (!sameFile(original, currentFile) || currentFile.isSymbolicLink() || currentFile.nlink !== 1n) throw new AppError('MIGRATION_STATE_INVALID', 'State metadata changed while opening it.');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const id = tables.has('webcodex_state_identity') ? db.prepare('SELECT device_id FROM webcodex_state_identity WHERE singleton=1').get()?.device_id : undefined;
    if (id !== undefined && (typeof id !== 'string' || !uuid.test(id))) throw new AppError('MIGRATION_STATE_INVALID', 'Stored device identity is invalid.');
    if (id !== undefined && config.device && config.device.id !== id) throw new AppError('STATE_DEVICE_MISMATCH', 'Configuration and local state belong to different device identities.');
    const workspaces = new Map<string, string>();
    if (tables.has('webcodex_workspace_bindings')) {
      for (const workspace of config.workspaces) {
        const root = process.platform === 'win32' ? workspace.root.toLowerCase() : workspace.root;
        const rows = workspace.uid
          ? db.prepare('SELECT workspace_uid,canonical_root FROM webcodex_workspace_bindings WHERE workspace_uid=? LIMIT 2').all(workspace.uid)
          : db.prepare("SELECT workspace_uid,canonical_root FROM webcodex_workspace_bindings WHERE canonical_root=? AND registration_kind='v1' LIMIT 2").all(root);
        if (rows.length > 1) throw new AppError('MIGRATION_IDENTITY_AMBIGUOUS', 'More than one stored workspace identity matches this root. Resolve it locally before migration.');
        if (rows.length) {
          const value = rows[0].workspace_uid;
          if (rows[0].canonical_root !== root) throw new AppError('WORKSPACE_IDENTITY_MISMATCH', 'A stored workspace UID belongs to another directory.');
          if (typeof value !== 'string' || !uuid.test(value)) throw new AppError('MIGRATION_STATE_INVALID', 'Stored workspace identity is invalid.');
          workspaces.set(workspace.id, value);
        }
      }
    }
    return { deviceId: id as string | undefined, workspaces };
  } finally { db.close(); }
}

/** Writes a new private file. Replacing an existing file requires the exact original bytes. */
export async function writePrivateConfig(target: string, value: unknown, expected?: Buffer, beforePublish?: () => Promise<void>) {
  target = path.resolve(target);
  const text = serializeConfig(value, configFormatForPath(target));
  if (Buffer.byteLength(text) > 1024 * 1024) throw new AppError('CONFIG_TOO_LARGE', 'Serialized configuration exceeds the supported 1 MiB read limit. Nothing was written.');
  await canonicalDirectory(path.dirname(target), true);
  const lockPath = target + '.lock';
  let lock: FileHandle;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('CONFIG_LOCKED', 'Another local operation owns the configuration lock.'); throw error; }
  const lockInfo = await lock.stat({ bigint: true });
  const temporary = path.join(path.dirname(target), '.webcodex-write-config-' + randomUUID());
  let temporaryInfo: BigIntStats | undefined;
  try {
    if (expected === undefined && await exists(target)) throw new AppError('CONFIG_EXISTS', 'The target configuration already exists; it was not overwritten.');
    const original = expected === undefined ? undefined : await safeSnapshot(target);
    if (original && sha(original.bytes) !== sha(expected!)) throw new AppError('CONFIG_CONFLICT', 'Configuration changed before writing. No replacement was made.');
    temporaryInfo = await privateContents(temporary, Buffer.from(text));
    await beforePublish?.();
    await canonicalDirectory(path.dirname(target));
    if (original) await unchanged(original);
    const currentTemporary = await lstat(temporary, { bigint: true });
    if (!sameFile(temporaryInfo, currentTemporary) || currentTemporary.nlink !== 1n || currentTemporary.isSymbolicLink() || currentTemporary.size !== temporaryInfo.size || currentTemporary.mtimeNs !== temporaryInfo.mtimeNs) throw new AppError('CONFIG_CONFLICT', 'Temporary configuration changed before publication.');
    if (original) {
      await rename(temporary, target);
      temporaryInfo = undefined;
    } else {
      // A hard link publishes the complete private file with create-only semantics.
      // There is no empty destination to leave behind if publication fails.
      try { await link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('CONFIG_EXISTS', 'The target configuration appeared during writing; it was not overwritten.'); throw error; }
      await removeOwned(temporary, temporaryInfo);
      temporaryInfo = undefined;
    }
    return { path: target, sha256: sha(Buffer.from(text)) };
  } finally {
    try { if (temporaryInfo) await removeOwned(temporary, temporaryInfo); }
    finally { await lock.close(); await removeOwned(lockPath, lockInfo); }
  }
}

export async function migrateConfiguration(input: { source: string; output: string; legacyAuth?: string; legacyConnect?: string; apply?: boolean }) {
  const source = path.resolve(input.source), output = path.resolve(input.output);
  const original = await safeSnapshot(source);
  const current = await validateConfig(parseConfigText(original.bytes.toString('utf8'), configFormatForPath(source)), await realpath(source));
  const sameTarget = process.platform === 'win32' ? source.toLowerCase() === output.toLowerCase() : source === output;
  if (!sameTarget && await exists(output)) throw new AppError('CONFIG_EXISTS', 'The migration target already exists.');
  const identities = await existingIdentities(current);
  const next: any = defaultUnifiedConfig(current.workspaces[0].root, output);
  next.device = { id: current.device?.id ?? identities.deviceId ?? randomUUID(), name: current.device?.name ?? 'Local device' };
  next.workspaces = current.workspaces.map(workspace => ({ ...workspace, uid: workspace.uid ?? identities.workspaces.get(workspace.id) ?? randomUUID() }));
  next.stateDir = current.stateDir;
  next.toolsDir = current.toolsDir ?? path.join(path.dirname(source), 'tools');
  next.nodePath = current.nodePath ?? process.execPath;
  next.gitPath = current.gitPath ?? 'auto';
  next.rgPath = current.rgPath;
  next.execution = { ...current.execution, defaultTimeoutMs: current.execution.defaultTimeoutMs ?? Math.min(60000, current.execution.maxTimeoutMs) };
  next.limits = current.limits;
  next.tasks = current.tasks ?? next.tasks;
  next.projectContext = current.projectContext ?? next.projectContext;
  next.fileBatches = current.fileBatches ?? next.fileBatches;
  next.codexSessions = { ...current.codexSessions, home: current.codexSessions.home };
  next.server = current.server ?? { transport: 'stdio' };
  next.http = { ...current.http, bearerToken: current.http.bearerToken ?? '' };
  next.localPanel = current.localPanel ?? next.localPanel;
  if (current.actionsProbe) next.actionsProbe = current.actionsProbe;
  const imported: Array<Snapshot & { kind: string }> = [];
  if (current.version === 1) {
    const authFile = input.legacyAuth ? path.resolve(input.legacyAuth) : path.join(path.dirname(source), 'private', 'tunnel-auth.json');
    const connectFile = input.legacyConnect ? path.resolve(input.legacyConnect) : path.join(path.dirname(source), 'connect.ps1');
    let apiKey = '', connection = { id: '', proxyUrl: '' };
    if (input.legacyAuth || await exists(authFile)) {
      const snapshot = await safeSnapshot(authFile, 16384);
      const auth: any = parseConfigText(snapshot.bytes.toString('utf8'), 'json');
      if (!auth || typeof auth !== 'object' || Object.keys(auth).length !== 1 || typeof auth.api_key !== 'string' || !auth.api_key.trim() || /\s/.test(auth.api_key.trim())) throw new AppError('MIGRATION_AUTH_INVALID', 'Legacy credentials are not a valid single-field API key file.');
      apiKey = auth.api_key.trim(); imported.push({ ...snapshot, kind: 'auth' });
    }
    if (input.legacyConnect || await exists(connectFile)) {
      const snapshot = await safeSnapshot(connectFile, 65536); connection = legacyConnection(snapshot.bytes);
      imported.push({ ...snapshot, kind: 'connection' });
    }
    if (!!apiKey !== !!connection.id) throw new AppError('MIGRATION_CONNECTION_INCOMPLETE', 'Migration requires both a static tunnel ID and its local API key, or neither for a non-tunnel configuration.');
    next.tunnel = { enabled: !!apiKey, ...connection, apiKey, clientPath: 'auto', clientVersion: 'auto' };
    const tokenFile = path.join(current.stateDir, 'http-token');
    if (await exists(tokenFile)) {
      const snapshot = await safeSnapshot(tokenFile, 8192); next.http.bearerToken = snapshot.bytes.toString('utf8').trim();
      imported.push({ ...snapshot, kind: 'http-token' });
    }
  } else next.tunnel = current.tunnel;
  const validated = await validateConfig(next, output);
  const summary = {
    source, output, version: 2, device_id: validated.device!.id,
    identities_provisional: !input.apply && ((!current.device && !identities.deviceId) || current.workspaces.some(workspace => !workspace.uid && !identities.workspaces.has(workspace.id))),
    workspaces: validated.workspaces.map(workspace => ({ workspace_id: workspace.id, workspace_uid: workspace.uid, root: workspace.root, read_only: workspace.readOnly })),
    execution_mode: validated.execution.mode, codex_home: validated.codexSessions.home,
    api_key_configured: !!validated.tunnel?.apiKey, http_token_configured: !!validated.http.bearerToken,
    ...(validated.actionsProbe ? { inactive_legacy_actions_probe: true } : {}),
    tunnel_id: validated.tunnel?.id ?? '', proxy_configured: !!validated.tunnel?.proxyUrl,
    legacy_sources: imported.map(source => source.kind),
    notice: 'Legacy unbound jobs and changes remain preserved but cannot be assigned to a new workspace automatically. Preview identities marked provisional are not persisted and may change on apply. Restart after applying. No credentials are printed.',
  };
  if (!input.apply) return { ok: true, applied: false, ...summary };
  const verifySources = async () => {
    for (const item of [original, ...imported]) await unchanged(item);
    const latest = await existingIdentities(current);
    if (latest.deviceId !== identities.deviceId || JSON.stringify([...latest.workspaces]) !== JSON.stringify([...identities.workspaces])) throw new AppError('CONFIG_CONFLICT', 'State identity metadata changed during migration. No configuration was published.');
  };
  await verifySources();
  const backupDir = path.join(current.stateDir, 'private-config-backups', randomUUID());
  await canonicalDirectory(backupDir, true);
  for (const item of [{ ...original, kind: 'config' }, ...imported]) {
    const destination = path.join(backupDir, item.kind + (item.kind === 'config' ? path.extname(source) : '.backup'));
    await privateContents(destination, item.bytes);
  }
  const written = await writePrivateConfig(output, next, sameTarget ? original.bytes : undefined, verifySources);
  return { ok: true, applied: true, ...summary, backup_directory: backupDir, sha256: written.sha256 };
}
