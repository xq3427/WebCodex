import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { defaultUnifiedConfig, discoverConfigPath, loadConfig, resolveConfigSelectionPath, validateConfig } from './config.js';
import { writePrivateConfig } from './config-migration.js';
import { AppError } from './errors.js';
import { inspectDocumentWidgetAsset } from './document-widget.js';
import { installSetupTools, type SetupToolsOptions, type SetupToolsResult } from './setup-tools.js';

export interface SetupOptions {
  config?: string;
  workspace?: string;
  proxyUrl?: string;
  onProgress?: (message: string) => void;
}

/** Standard per-user configuration location used when an npm-installed CLI is
 * launched from node_modules (where creating .webcodex would be surprising). */
export function userConfigPath(): string {
  const home = homedir();
  const directory = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'WebCodex')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'WebCodex')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'webcodex');
  return path.join(directory, 'config.toml');
}

/** An explicit missing selection is a new install; implicit discovery preserves JSON and TOML equally. */
export async function selectSetupConfig(explicit?: string): Promise<string> {
  const selected = explicit ?? process.env.WEBCODEX_CONFIG;
  if (selected !== undefined) return resolveConfigSelectionPath(selected);
  try { return await discoverConfigPath(); }
  catch (error) {
    if (!(error instanceof AppError) || error.code !== 'CONFIG_NOT_FOUND') throw error;
    return resolveConfigSelectionPath('.webcodex/config.toml');
  }
}

/** Local human setup only. Existing configuration bytes, identities, credentials and permissions are never changed. */
export async function setupConfiguration(options: SetupOptions, dependencies: {
  installTools?: (options: SetupToolsOptions) => Promise<SetupToolsResult>;
} = {}) {
  const configPath = await selectSetupConfig(options.config);
  let exists = false;
  try { await lstat(configPath); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists) {
    const config = await loadConfig(configPath, { workspaceDiagnostics: true });
    options.onProgress?.('Existing configuration preserved. Manage its paths, credentials and permissions in the dashboard.');
    return { config, report: { ok: true, config: configPath, created: false, preserved: true, dependencies_checked: false,
      notice: 'Existing configuration was loaded without modification. Run doctor for its dependency checks; setup does not repair or replace user-selected tools.' } };
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 16) throw new AppError('SETUP_NODE_REQUIRED', 'Setup requires Node.js 22.16 or newer.');
  inspectDocumentWidgetAsset();
  const configDirectory = path.dirname(configPath);
  const defaultRoot = path.basename(configDirectory).toLowerCase() === '.webcodex' ? path.dirname(configDirectory) : configDirectory;
  const workspace = path.resolve(options.workspace ?? path.join(defaultRoot, 'workspace'));
  await mkdir(workspace, { recursive: true });
  const root = await realpath(workspace);
  const raw = defaultUnifiedConfig(root, configPath, { fullLocalAccess: true });
  raw.http.bearerToken = randomBytes(32).toString('hex');
  // Validate the new workspace and private configuration destination before downloading tools.
  await validateConfig(raw, configPath);
  const tools = await (dependencies.installTools ?? installSetupTools)({
    toolsDir: path.join(path.dirname(configPath), 'tools'), proxyUrl: options.proxyUrl, onProgress: options.onProgress,
  });
  raw.nodePath = tools.nodePath;
  raw.gitPath = tools.gitPath;
  raw.rgPath = tools.rgPath;
  // The verified install.json under toolsDir selects the official tunnel client.
  // Download proxy configuration is not silently turned into persistent runtime routing.
  await validateConfig(raw, configPath);
  await writePrivateConfig(configPath, raw);
  const config = await loadConfig(configPath);
  return { config, report: { ok: true, config: configPath, created: true, preserved: false, workspace: root,
    dependencies_checked: true, tools: tools.installed, execution_mode: 'trusted-host', command_policy: 'all', workspace_access: 'read-write', codex_history_enabled: false,
    connection: 'Local installation ready. Configure your own Tunnel ID and API key in the dashboard before connecting ChatGPT.' } };
}
