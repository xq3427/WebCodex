import { constants, type BigIntStats } from 'node:fs';
import { open, lstat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WorkspacePaths } from './paths.js';
import { AppError } from './errors.js';
import { workspaceHealth } from './workspace-health.js';
import type { AppConfig } from './types.js';

export type LocalAccessCheck = {
  ok: true;
  full_access_ready: boolean;
  checked_at: string;
  privilege_scope: 'current_os_account';
  elevation: 'not_requested';
  execution: {
    status: 'ready' | 'disabled' | 'allowlist' | 'process-failed';
    mode: 'disabled' | 'trusted-host';
    command_policy: 'all' | 'allowlist';
    all_native_programs: boolean;
    process_probe: 'passed' | 'not-run' | 'failed';
    error_code: string | null;
  };
  workspaces: Array<{
    workspace_id: string;
    name: string;
    root: string;
    configured_access: 'disabled' | 'read-only' | 'read-write';
    status: 'passed' | 'disabled' | 'read-only' | 'unavailable' | 'os-write-denied' | 'write-failed' | 'cleanup-failed';
    error_code: string | null;
    write_probe: 'not-run' | 'created-read-verified-deleted' | 'cleanup-failed';
  }>;
};

function publicFailure(error: unknown): { status: 'unavailable' | 'os-write-denied' | 'write-failed'; code: string } {
  if (error instanceof AppError) return { status: /^(?:WORKSPACE_|PATH_DENIED|READ_ONLY)/.test(error.code) ? 'unavailable' : 'write-failed', code: error.code };
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return { status: 'os-write-denied', code };
  if (code === 'ENOENT' || code === 'ENODEV' || code === 'EBUSY') return { status: 'unavailable', code };
  return { status: 'write-failed', code: 'WRITE_PROBE_FAILED' };
}

/**
 * Prove that the current OS account can create, read and remove an ordinary
 * file in every configured writable workspace. The random test file contains
 * no user data and is removed before a successful result is returned.
 */
export async function checkLocalAccess(config: AppConfig): Promise<LocalAccessCheck> {
  const paths = new WorkspacePaths(config);
  const executionPolicy = config.execution.commandPolicy ?? 'allowlist';
  const configuredExecutionStatus = config.execution.mode !== 'trusted-host' ? 'disabled' : executionPolicy === 'all' ? 'ready' : 'allowlist';
  const workspaces: LocalAccessCheck['workspaces'] = [];
  for (const workspace of config.workspaces) {
    const base = { workspace_id: workspace.id, name: workspace.name, root: workspace.root };
    if (workspace.enabled === false) {
      workspaces.push({ ...base, configured_access: 'disabled', status: 'disabled', error_code: 'WORKSPACE_DISABLED', write_probe: 'not-run' });
      continue;
    }
    if (workspace.readOnly) {
      workspaces.push({ ...base, configured_access: 'read-only', status: 'read-only', error_code: 'READ_ONLY', write_probe: 'not-run' });
      continue;
    }
    const health = workspaceHealth(config, workspace);
    if (!health.available) {
      workspaces.push({ ...base, configured_access: 'read-write', status: 'unavailable', error_code: health.error_code, write_probe: 'not-run' });
      continue;
    }
    const relative = 'webcodex-access-check-' + randomBytes(12).toString('hex') + '.tmp';
    let absolute: string | undefined, createdIdentity: BigIntStats | undefined;
    let created = false;
    const sameFile = (left: BigIntStats, right: BigIntStats) => left.ino === right.ino && left.birthtimeNs === right.birthtimeNs
      && (left.dev === right.dev || process.platform === 'win32' && (left.dev === 0n || right.dev === 0n));
    const removeCreated = async () => {
      if (!created || !absolute || !createdIdentity) return;
      const current = await lstat(absolute, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameFile(createdIdentity, current)) throw new AppError('WRITE_PROBE_CLEANUP_FAILED', 'The access-check file identity changed before cleanup.');
      await unlink(absolute); created = false;
    };
    try {
      absolute = await paths.resolve(workspace.id, relative, { write: true, allowMissing: true });
      const expected = randomBytes(32);
      const output = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      created = true;
      try { await output.writeFile(expected); await output.sync(); } finally { await output.close(); }
      const before = await lstat(absolute, { bigint: true }); createdIdentity = before;
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(expected.length)) throw new AppError('WRITE_PROBE_FAILED', 'The access-check file did not remain an ordinary file.');
      const input = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let actual: Buffer;
      try {
        const opened = await input.stat({ bigint: true });
        if (!sameFile(before, opened) || opened.nlink !== 1n || !opened.isFile()) throw new AppError('WRITE_PROBE_FAILED', 'The access-check file changed before readback.');
        actual = await input.readFile();
      } finally { await input.close(); }
      if (!actual.equals(expected)) throw new AppError('WRITE_PROBE_FAILED', 'The access-check bytes did not read back unchanged.');
      const after = await lstat(absolute, { bigint: true });
      if (!sameFile(before, after) || after.nlink !== 1n || !after.isFile() || after.size !== before.size) throw new AppError('WRITE_PROBE_FAILED', 'The access-check file changed after readback.');
      await removeCreated();
      workspaces.push({ ...base, configured_access: 'read-write', status: 'passed', error_code: null, write_probe: 'created-read-verified-deleted' });
    } catch (error) {
      if (created && absolute) {
        try { await removeCreated(); }
        catch {
          workspaces.push({ ...base, configured_access: 'read-write', status: 'cleanup-failed', error_code: 'WRITE_PROBE_CLEANUP_FAILED', write_probe: 'cleanup-failed' });
          continue;
        }
      }
      const failure = publicFailure(error);
      workspaces.push({ ...base, configured_access: 'read-write', status: failure.status, error_code: failure.code, write_probe: 'not-run' });
    }
  }
  let executionStatus: LocalAccessCheck['execution']['status'] = configuredExecutionStatus;
  let processProbe: LocalAccessCheck['execution']['process_probe'] = 'not-run', executionError: string | null = null;
  if (configuredExecutionStatus === 'ready') {
    const cwd = workspaces.find(item => item.status === 'passed')?.root;
    if (!cwd) { executionStatus = 'process-failed'; processProbe = 'failed'; executionError = 'NO_WRITABLE_WORKSPACE'; }
    else try {
      await new Promise<void>((resolve, reject) => {
        const marker = 'WEBCODEX_ACCESS_OK'; let stdout = '', stderrBytes = 0, settled = false;
        const child = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(marker)})`], { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
        const timer = setTimeout(() => { child.kill(); finish(new Error('timeout')); }, 5000);
        child.stdout.on('data', chunk => { if (stdout.length < marker.length + 16) stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderrBytes += Buffer.byteLength(chunk); });
        child.once('error', finish);
        child.once('close', code => code === 0 && stdout === marker && stderrBytes === 0 ? finish() : finish(new Error('failed')));
      });
      processProbe = 'passed';
    } catch { executionStatus = 'process-failed'; processProbe = 'failed'; executionError = 'PROCESS_PROBE_FAILED'; }
  }
  return {
    ok: true,
    full_access_ready: executionStatus === 'ready' && workspaces.filter(item => item.configured_access !== 'disabled').every(item => item.status === 'passed'),
    checked_at: new Date().toISOString(), privilege_scope: 'current_os_account', elevation: 'not_requested',
    execution: { status: executionStatus, mode: config.execution.mode, command_policy: executionPolicy, all_native_programs: executionStatus === 'ready', process_probe: processProbe, error_code: executionError },
    workspaces,
  };
}
