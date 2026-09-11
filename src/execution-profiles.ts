import { AppError } from './errors.js';
import { normalizeExecutionEnvironment } from './execution-env.js';
import type { AppConfig, ExecutableConfig } from './types.js';

export interface EffectiveWorkspaceExecution {
  profile: string | null;
  commandPolicy: 'all' | 'allowlist';
  allowedExecutables: Record<string, ExecutableConfig>;
  env: Record<string, string>;
}

/** A profile selects environment/presets; only legacy allowlist mode uses it to limit programs. */
export function effectiveWorkspaceExecution(config: AppConfig, workspaceId: string): EffectiveWorkspaceExecution {
  const workspace = config.workspaces.find(item => item.id === workspaceId);
  if (!workspace) throw new AppError('WORKSPACE_NOT_FOUND', 'Unknown or unauthorized workspace.');
  const profile = workspace.executionProfile ?? null;
  const profiles = config.execution.profiles;
  if (profile !== null && (typeof profile !== 'string' || !profiles || !Object.hasOwn(profiles, profile))) {
    throw new AppError('EXECUTION_PROFILE_NOT_FOUND', 'The workspace execution profile is not configured. Repair its local configuration before running commands.');
  }
  const selected = profile === null ? config.execution : profiles![profile]!;
  const commandPolicy = config.execution.commandPolicy ?? 'allowlist';
  if (!selected || typeof selected.allowedExecutables !== 'object' || selected.allowedExecutables === null || Array.isArray(selected.allowedExecutables)) {
    throw new AppError('INVALID_EXECUTABLE', 'Execution aliases must be a locally configured object.');
  }
  const presets = commandPolicy === 'all' ? { ...config.execution.allowedExecutables, ...selected.allowedExecutables } : selected.allowedExecutables;
  const allowedExecutables = Object.fromEntries(Object.entries(presets).map(([alias, value]) => {
    if (typeof value !== 'string' && (!value || typeof value !== 'object' || !Array.isArray(value.args))) throw new AppError('INVALID_EXECUTABLE', 'Execution aliases must identify native programs and fixed argument arrays.');
    return [alias, typeof value === 'string' ? value : { ...value, args: [...value.args] }];
  })) as Record<string, ExecutableConfig>;
  return { profile, commandPolicy, allowedExecutables, env: normalizeExecutionEnvironment(selected.env) };
}

/** Public configuration summary: fixed arguments and environment values are intentionally excluded. */
export function publicWorkspaceExecution(config: AppConfig, workspaceId: string) {
  const effective = effectiveWorkspaceExecution(config, workspaceId);
  return {
    profile: effective.profile,
    enabled: config.execution.mode === 'trusted-host',
    command_policy: effective.commandPolicy,
    accepts: effective.commandPolicy === 'all' ? 'native_program_name_or_absolute_path_and_configured_presets' : 'configured_workspace_aliases_only',
    executable_aliases: Object.keys(effective.allowedExecutables).sort(),
    executables: Object.entries(effective.allowedExecutables).map(([alias, definition]) => ({
      alias, command: typeof definition === 'string' ? definition : definition.command,
      prefix_arg_count: typeof definition === 'string' ? 0 : definition.args.length,
    })),
    configured_environment_names: Object.keys(effective.env).sort(),
  };
}
