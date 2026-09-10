import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { assertWorkspaceRoot } from './worktree-policy.js';
import { assertWorkspaceAvailable, bindWorkspaceRuntime, inspectWorkspace, workspaceHealth, unavailableHealth } from './workspace-health.js';
import type { AppConfig, ServiceContext, Store, WorkspaceConfig } from './types.js';

type IdentityConfig = AppConfig & { device?: { id: string; name: string } };
type IdentityWorkspace = WorkspaceConfig & { uid?: string };
interface Binding { binding_id: string; workspace_uid: string; canonical_root: string; registration_kind: string; root_fingerprint?: string | null }
interface Registration { binding: Binding; configuredUid: string | undefined }
export interface BoundRecord { workspace_binding: string | null }

const registries = new WeakMap<ServiceContext, IdentityRegistry>();
const canonicalRoot = (root: string) => process.platform === 'win32' ? root.toLowerCase() : root;

function checkedRoot(ctx: ServiceContext, workspace: WorkspaceConfig): string {
  assertWorkspaceAvailable(ctx.config, workspace);
  return canonicalRoot(assertWorkspaceRoot(ctx.config, workspace));
}

/** The state lease is acquired by StateStore before any identity is registered. */
export class IdentityRegistry {
  readonly deviceId: string;
  private readonly configuredDeviceId: string | undefined;
  private readonly registrations = new Map<string, Registration>();

  constructor(private readonly ctx: ServiceContext) {
    const config = ctx.config as IdentityConfig;
    this.configuredDeviceId = config.device?.id;
    const workspaces = ctx.paths.list();
    const runtime = new Map<string, string | null>();
    const db = ctx.store.db;
    db.exec('SAVEPOINT register_identity');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS webcodex_state_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), device_id TEXT NOT NULL, created_at TEXT NOT NULL
      ); CREATE TABLE IF NOT EXISTS webcodex_workspace_bindings (
        binding_id TEXT PRIMARY KEY, workspace_uid TEXT NOT NULL UNIQUE, canonical_root TEXT NOT NULL,
        registration_kind TEXT NOT NULL, created_at TEXT NOT NULL
      ); CREATE INDEX IF NOT EXISTS webcodex_workspace_roots ON webcodex_workspace_bindings(canonical_root, registration_kind);`);
      const columns = new Set(db.prepare('PRAGMA table_info(webcodex_workspace_bindings)').all().map(row => row.name));
      if (!columns.has('root_fingerprint')) db.exec('ALTER TABLE webcodex_workspace_bindings ADD COLUMN root_fingerprint TEXT');
      const saved = db.prepare('SELECT device_id FROM webcodex_state_identity WHERE singleton=1').get() as { device_id: string } | undefined;
      if (saved && config.device && saved.device_id !== config.device.id) throw new AppError('STATE_DEVICE_MISMATCH', 'This state directory belongs to another device ID. Use its original device identity or a new local state directory.');
      this.deviceId = saved?.device_id ?? config.device?.id ?? randomUUID();
      if (!saved) db.prepare('INSERT INTO webcodex_state_identity(singleton,device_id,created_at) VALUES(1,?,?)').run(this.deviceId, new Date().toISOString());
      for (const workspace of workspaces) {
        runtime.set(workspace.id, null);
        if (workspace.enabled === false) continue;
        const inspected = inspectWorkspace(config, workspace);
        if (!inspected.health.available) {
          if (workspace.onUnavailable === 'skip' && ['missing', 'inaccessible'].includes(inspected.health.status)) continue;
          throw new AppError(inspected.health.error_code!, 'Workspace directory is unavailable or blocked. Check the local configuration.');
        }
        const root = canonicalRoot(inspected.root!);
        let binding = (workspace.uid
          ? db.prepare('SELECT * FROM webcodex_workspace_bindings WHERE workspace_uid=?').get(workspace.uid)
          : db.prepare("SELECT * FROM webcodex_workspace_bindings WHERE canonical_root=? AND registration_kind='v1' ORDER BY created_at,binding_id LIMIT 1").get(root)) as Binding | undefined;
        if (binding && (binding.canonical_root !== root || binding.root_fingerprint && binding.root_fingerprint !== inspected.fingerprint)) {
          if (workspace.onUnavailable === 'skip') {
            // Keep the prior binding as evidence of the mismatch; never update it to the replacement directory.
            this.registrations.set(workspace.id, { binding, configuredUid: workspace.uid });
            runtime.set(workspace.id, binding.root_fingerprint ?? 'mismatched-root');
            continue;
          }
          throw new AppError('WORKSPACE_IDENTITY_MISMATCH', 'This workspace identity is bound to another directory or its physical root was replaced. Register a new workspace UID for the intended project.');
        }
        if (!binding) {
          binding = { binding_id: randomUUID(), workspace_uid: workspace.uid ?? randomUUID(), canonical_root: root, registration_kind: workspace.uid ? 'v2' : 'v1', root_fingerprint: inspected.fingerprint };
          db.prepare('INSERT INTO webcodex_workspace_bindings(binding_id,workspace_uid,canonical_root,registration_kind,root_fingerprint,created_at) VALUES(?,?,?,?,?,?)')
            .run(binding.binding_id, binding.workspace_uid, root, binding.registration_kind, binding.root_fingerprint!, new Date().toISOString());
        } else if (!binding.root_fingerprint) {
          binding.root_fingerprint = inspected.fingerprint;
          db.prepare('UPDATE webcodex_workspace_bindings SET root_fingerprint=? WHERE binding_id=?').run(binding.root_fingerprint!, binding.binding_id);
        }
        this.registrations.set(workspace.id, { binding, configuredUid: workspace.uid });
        runtime.set(workspace.id, binding.root_fingerprint!);
      }
      db.exec('RELEASE register_identity');
      bindWorkspaceRuntime(config, runtime);
    } catch (error) {
      db.exec('ROLLBACK TO register_identity; RELEASE register_identity');
      throw error;
    }
  }

  private assertDevice() {
    if ((this.ctx.config as IdentityConfig).device?.id !== this.configuredDeviceId) throw new AppError('STATE_DEVICE_MISMATCH', 'Device identity changed while this service was running. Restart with the bound device configuration.');
  }

  workspaceIdentity(workspaceId: string): string {
    const workspace = this.ctx.paths.get(workspaceId) as IdentityWorkspace;
    const root = checkedRoot(this.ctx, workspace);
    this.assertDevice();
    const registered = this.registrations.get(workspaceId);
    if (!registered || registered.configuredUid !== workspace.uid || registered.binding.canonical_root !== root) throw new AppError('WORKSPACE_IDENTITY_MISMATCH', 'Workspace identity or root changed while this service was running. Restart after registering the intended project.');
    return registered.binding.binding_id;
  }

  source() {
    this.assertDevice();
    return { device_id: this.deviceId, device_name: (this.ctx.config as IdentityConfig).device?.name ?? 'Local device' };
  }

  workspaceSource(workspaceId: string) {
    this.workspaceIdentity(workspaceId);
    return { ...this.source(), workspace_uid: this.registrations.get(workspaceId)!.binding.workspace_uid };
  }

  /** Listing is deliberately per-workspace: one missing disk must not erase the other entries. */
  workspaceDescription(workspaceId: string) {
    this.assertDevice();
    const workspace = this.ctx.config.workspaces.find(item => item.id === workspaceId);
    if (!workspace) throw new AppError('WORKSPACE_NOT_FOUND', 'Unknown workspace.');
    let health = workspaceHealth(this.ctx.config, workspace);
    const registration = this.registrations.get(workspaceId);
    if (health.available && (!registration || registration.configuredUid !== workspace.uid || registration.binding.canonical_root !== canonicalRoot(workspace.root))) {
      health = unavailableHealth('identity_mismatch', 'WORKSPACE_IDENTITY_MISMATCH');
    }
    return { ...this.source(), workspace_id: workspace.id, workspace_uid: workspace.uid ?? registration?.binding.workspace_uid ?? null,
      name: workspace.name, root: workspace.root, read_only: workspace.readOnly, enabled: workspace.enabled !== false,
      on_unavailable: workspace.onUnavailable ?? 'error', linked_worktree: !!workspace.worktree, ...health };
  }
}

/** Call after creating ctx, before constructing services. Direct service construction is supported too. */
export function initializeIdentity(ctx: ServiceContext): IdentityRegistry {
  let registry = registries.get(ctx);
  if (!registry) { registry = new IdentityRegistry(ctx); registries.set(ctx, registry); }
  return registry;
}

/** Existing rows intentionally remain NULL: their original project ownership cannot be inferred. */
export function addRecordBinding(store: Store, table: 'file_changes' | 'webcodex_jobs') {
  const columns = new Set(store.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  if (!columns.has('workspace_binding')) store.db.exec(`ALTER TABLE ${table} ADD COLUMN workspace_binding TEXT`);
  store.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_binding ON ${table}(workspace_binding,workspace_id,created_at)`);
}

export function assertRecordBinding(row: BoundRecord, binding: string, notFoundCode: 'CHANGE_NOT_FOUND' | 'JOB_NOT_FOUND') {
  if (!row.workspace_binding) throw new AppError('LEGACY_RECORD_UNBOUND', 'This record predates workspace identity binding. It is preserved locally but cannot be read or restored as evidence for the current workspace.');
  if (row.workspace_binding !== binding) throw new AppError(notFoundCode, 'No record with this ID belongs to the current workspace identity.');
}

/** Validate ownership before the store may return a cached result, and again before a new action. */
export function boundOperation<T>(ctx: ServiceContext, workspaceId: string, tool: string, key: string, payload: unknown, action: () => Promise<T>, legacyScopes: string[] = []): Promise<T> {
  const registry = initializeIdentity(ctx);
  const binding = registry.workspaceIdentity(workspaceId);
  for (const scope of legacyScopes) {
    if (ctx.store.db.prepare('SELECT 1 FROM operations WHERE scope=? AND op_key=?').get(scope, key)) throw new AppError('LEGACY_OPERATION_UNBOUND', 'This operation key exists in legacy state with unknown project ownership. Inspect the original local records before choosing a new operation ID.');
  }
  const scope = 'workspace:' + binding + '/' + tool;
  return ctx.store.idempotent(scope, key, payload, async () => {
    if (registry.workspaceIdentity(workspaceId) !== binding) throw new AppError('WORKSPACE_IDENTITY_MISMATCH', 'Workspace identity changed before this operation started.');
    return action();
  });
}

export function legacyCheckpointScope(absolute: string) {
  return 'checkpoint_save:' + createHash('sha256').update(canonicalRoot(absolute)).digest('hex');
}
