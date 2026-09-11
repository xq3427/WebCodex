import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { executableDefinition, loadConfig } from './config.js';
import { editConfig } from './config-admin.js';
import { normalizeExecutionEnvironment } from './execution-env.js';
import { AppError } from './errors.js';
import type { AppConfig, ExecutableConfig } from './types.js';
import { effectiveWorkspaceExecution } from './execution-profiles.js';
import { workspaceHealth } from './workspace-health.js';

export type ExecutionPreset = 'node' | 'npm' | 'python' | 'venv' | 'conda';
export interface ExecutionPresetInput { preset: ExecutionPreset; alias?: string; command?: string; entry?: string; prefix?: string }
type NativeStatus = 'available' | 'missing' | 'not_native' | 'inaccessible';

async function nativeStatus(command: string): Promise<NativeStatus> {
  if (!path.isAbsolute(command) || /[\x00-\x1f\x7f]/.test(command) || /\.(?:bat|cmd|ps1|sh|[cm]?js|py)$/i.test(command)) return 'not_native';
  try {
    if (!(await stat(command)).isFile()) return 'not_native';
    await access(command, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    const handle = await open(command, 'r');
    try {
      const header = Buffer.alloc(4);
      const { bytesRead } = await handle.read(header, 0, 4, 0);
      const magic = header.toString('hex');
      if (bytesRead < 4 || !(/^(?:4d5a|7f454c46|feedface|cefaedfe|feedfacf|cffaedfe|cafebabe|bebafeca|cafebabf|bfbafeca)/.test(magic))) return 'not_native';
    } finally { await handle.close(); }
    return 'available';
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'inaccessible'; }
}

async function regularFile(file: string): Promise<boolean> {
  if (!path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) return false;
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function nativeProgram(command: string): Promise<string> {
  if (await nativeStatus(command) !== 'available') throw new AppError('EXECUTION_PROGRAM_REQUIRED', 'Select an existing absolute native executable path; shell wrappers and activation scripts are unsupported.');
  // Preserve the selected path: resolving a Python virtualenv symlink can select the base environment.
  return path.resolve(command);
}

async function discoverPython(): Promise<string> {
  const candidates = new Map<string, string>();
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory)) continue;
    for (const name of process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']) {
      const candidate = path.join(directory, name);
      if (await nativeStatus(candidate) === 'available') {
        const [canonicalDirectory, canonicalBinary] = await Promise.all([realpath(path.dirname(candidate)), realpath(candidate)]);
        // Different virtualenv entry directories retain different environment
        // semantics even when both symlinks resolve to the same base binary.
        const identity = JSON.stringify([canonicalDirectory, canonicalBinary].map(value => process.platform === 'win32' ? value.toLowerCase() : value));
        // python/python3 in one directory may be aliases; preserve the first
        // discovered entry instead of silently replacing it later in PATH.
        if (!candidates.has(identity)) candidates.set(identity, candidate);
      }
    }
  }
  if (candidates.size !== 1) throw new AppError('EXECUTION_PROGRAM_REQUIRED', 'Python discovery did not identify exactly one native interpreter. Select its absolute path with --command.');
  return candidates.values().next().value!;
}

async function npmEntry(command: string, explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    if (!await regularFile(explicit) || path.basename(explicit).toLowerCase() !== 'npm-cli.js') throw new AppError('EXECUTION_ENTRY_REQUIRED', 'Select an existing absolute npm-cli.js path with --entry.');
    return path.resolve(explicit);
  }
  const nodeDir = path.dirname(command);
  const candidates = [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const candidate of candidates) if (await regularFile(candidate)) return path.resolve(candidate);
  // Unix package managers often expose npm as a symlink to the package's JS entry.
  const adjacent = path.join(nodeDir, 'npm');
  try {
    const resolved = await realpath(adjacent);
    if (path.basename(resolved) === 'npm-cli.js' && await regularFile(resolved)) return resolved;
  } catch { /* No shell wrapper is parsed or run. */ }
  throw new AppError('EXECUTION_ENTRY_REQUIRED', 'No npm-cli.js was found beside the selected Node installation. Select its absolute path with --entry.');
}

/** Static inspection only: no project script, interpreter, shell, App or SQLite store is opened. */
async function inspectAliases(aliases: Record<string, ExecutableConfig>) {
  return Promise.all(Object.entries(aliases).map(async ([alias, value]) => {
    const definition = executableDefinition(value);
    const status = await nativeStatus(definition.command);
    const first = definition.args[0];
    const entryFile = first !== undefined && path.isAbsolute(first) && /\.(?:[cm]?js|py)$/i.test(first);
    const entryAvailable = entryFile ? await regularFile(first) : undefined;
    return { alias, command: definition.command, available: status === 'available' && entryAvailable !== false, status: entryAvailable === false ? 'entry_missing' as const : status, prefix_arg_count: definition.args.length, ...(entryFile ? { entry_file_available: entryAvailable } : {}) };
  }));
}

export async function inspectExecution(config: AppConfig) {
  const commandPolicy = config.execution.commandPolicy ?? 'allowlist';
  const env = normalizeExecutionEnvironment(config.execution.env);
  const executables = await inspectAliases(config.execution.allowedExecutables);
  const workspaces = await Promise.all(config.workspaces.map(async workspace => {
    const effective = effectiveWorkspaceExecution(config, workspace.id);
    const programs = await inspectAliases(effective.allowedExecutables);
    const health = workspaceHealth(config, workspace);
    return { workspace_id:workspace.id, profile:effective.profile, ...health,
      command_policy: commandPolicy, program_resolution_at_launch: commandPolicy === 'all',
      ready:health.available && !workspace.readOnly && config.execution.mode === 'trusted-host' && (commandPolicy === 'all' || programs.length > 0 && programs.every(program => program.available)),
      configured_environment_names:Object.keys(effective.env).sort(), executables:programs };
  }));
  return { ok: true, mode: config.execution.mode, command_policy: commandPolicy, program_resolution_at_launch: commandPolicy === 'all', ready: config.execution.mode === 'trusted-host' && (commandPolicy === 'all' || executables.length > 0 && executables.every(exe => exe.available)), readiness_scope:'global_defaults', static_check_only: true, configured_environment_names: Object.keys(env).sort(), executables, workspaces };
}

/** Local owner operation: register a verified entry point while preserving the configured execution mode. */
export async function configureExecutionPreset(configPath: string, input: ExecutionPresetInput) {
  if (!['node', 'npm', 'python', 'venv', 'conda'].includes(input.preset)) throw new AppError('INVALID_ARGUMENT', 'Supported execution presets are node, npm, python, venv and conda.');
  const alias = input.alias ?? input.preset;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(alias) || ['__proto__', 'prototype', 'constructor'].includes(alias)) throw new AppError('CONFIG_ERROR', 'Select an unreserved executable alias containing 1–64 letters, digits, underscores or hyphens.');
  if (input.preset !== 'npm' && input.entry !== undefined || !['venv', 'conda'].includes(input.preset) && input.prefix !== undefined) throw new AppError('INVALID_ARGUMENT', '--entry is supported only by npm; --prefix is supported only by venv and conda.');
  const config = await loadConfig(configPath);
  let command: string;
  if (input.preset === 'venv' || input.preset === 'conda') {
    if (input.command !== undefined || !input.prefix || !path.isAbsolute(input.prefix) || /[\x00-\x1f\x7f]/.test(input.prefix)) throw new AppError('EXECUTION_PREFIX_REQUIRED', 'Select an existing environment directory with --prefix; its interpreter is used directly without shell activation.');
    const marker = path.join(input.prefix, input.preset === 'venv' ? 'pyvenv.cfg' : 'conda-meta');
    let valid = false;
    try { const info = await stat(marker); valid = input.preset === 'venv' ? info.isFile() : info.isDirectory(); } catch { /* Static validation only. */ }
    if (!valid) throw new AppError('EXECUTION_PREFIX_REQUIRED', 'The selected prefix does not contain the expected virtualenv or conda environment metadata.');
    command = path.join(input.prefix, ...(process.platform === 'win32' ? input.preset === 'venv' ? ['Scripts', 'python.exe'] : ['python.exe'] : ['bin', 'python']));
  } else if (input.preset === 'python') command = input.command ?? await discoverPython();
  else command = input.command ?? config.nodePath ?? process.execPath;
  command = await nativeProgram(command);
  const args = input.preset === 'npm' ? [await npmEntry(command, input.entry)] : [];
  const result = await editConfig(configPath, (raw, current) => {
    const aliases = raw.execution.allowedExecutables ??= {};
    const previous = current.execution.allowedExecutables[alias];
    if (previous) {
      const old = executableDefinition(previous);
      if (old.command !== command || JSON.stringify(old.args) !== JSON.stringify(args)) throw new AppError('EXECUTABLE_EXISTS', 'Executable alias is already configured differently; remove it explicitly before replacement.');
      return;
    }
    Object.defineProperty(aliases, alias, { enumerable: true, configurable: true, writable: true, value: { command, args } });
  });
  return { ...result, preset: input.preset, alias, execution_enabled: result.execution.mode === 'trusted-host', ...(result.execution.mode === 'disabled' ? { next_step: 'Execution remains disabled. Enable trusted-host locally only when ready to authorize project commands.' } : {}) };
}
