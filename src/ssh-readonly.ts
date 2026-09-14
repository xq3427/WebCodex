import { AppError } from './errors.js';
import type { App } from './app.js';

export type SshProbeKind = 'identity' | 'roots' | 'project_candidates' | 'git_status' | 'processes' | 'gpu' | 'directory_listing';

function quote(value: string): string {
  // POSIX shell single-quoted literal. Values are configuration supplied and
  // never interpreted as command syntax.
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function readonlySshCommand(kind: SshProbeKind, projectRoot?: string): string {
  switch (kind) {
    case 'identity': return 'whoami';
    case 'roots': return 'pwd; printf "\\n-- roots --\\n"; ls -ld /root /workspace 2>&1';
    case 'project_candidates': return "find /workspace /root -maxdepth 3 -type d -name .git -print 2>/dev/null";
    case 'git_status':
      if (!projectRoot) throw new AppError('SSH_PROJECT_ROOT_REQUIRED', 'This probe requires projectRoot in the remote configuration.');
      return `git -C ${quote(projectRoot)} status --short --branch`;
    case 'processes': return 'ps -eo pid,comm,args --sort=-%cpu | head -n 50';
    case 'gpu': return 'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader 2>&1';
    case 'directory_listing': return `ls -la ${quote(projectRoot || '.')}`;
  }
}

/** Fixed-command SSH diagnostics. The caller cannot submit an arbitrary
 * remote command; this is intentionally separate from exec_start so hosts can
 * classify it as read-only. */
export class SshReadonlyService {
  constructor(private readonly app: App) {}

  async probe(input: { remote_id: string; probe: SshProbeKind; timeout_ms?: number }) {
    const remote = this.app.config.remotes?.[input.remote_id];
    if (!remote) throw new AppError('SSH_REMOTE_NOT_FOUND', 'The requested remote is not configured locally.');
    if (this.app.config.execution.mode !== 'trusted-host') throw new AppError('EXECUTION_DISABLED', 'Read-only SSH diagnostics require trusted-host execution to be enabled locally.');
    const command = readonlySshCommand(input.probe, remote.projectRoot);
    const sshArgs = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1', '-o', 'StrictHostKeyChecking=yes', ...(remote.knownHostsFile ? ['-o', `UserKnownHostsFile=${remote.knownHostsFile}`] : []), '-i', remote.identityFile, '-p', String(remote.port), `${remote.user}@${remote.host}`, command];
    const key = `ssh-readonly:${input.remote_id}:${input.probe}`;
    const started = await this.app.jobs.start({ workspace_id: this.app.config.workspaces[0]!.id, executable: 'ssh', args: sshArgs, timeout_ms: Math.min(input.timeout_ms ?? 30000, 120000), idempotency_key: key });
    let cursor = 0;
    for (let i = 0; i < 130; i++) {
      const observed = await this.app.jobs.wait({ workspace_id: this.app.config.workspaces[0]!.id, job_id: started.job_id, cursor, wait_ms: 500, max_bytes: 65536 });
      cursor = observed.next_cursor;
      if (observed.terminal) {
        const final = this.app.jobs.poll({ workspace_id: this.app.config.workspaces[0]!.id, job_id: started.job_id, cursor: 0, max_bytes: 1024 * 1024 });
        return { remote_id: input.remote_id, probe: input.probe, command_class: 'fixed_read_only', job_id: started.job_id, status: final.status, exit_code: final.exit_code, output: final.output, output_truncated: final.output_truncated };
      }
    }
    throw new AppError('SSH_PROBE_TIMEOUT', 'The fixed read-only SSH probe did not finish within the bounded wait. Inspect the returned job with exec_poll.');
  }
}
