import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { discoverConfigPath, loadConfig } from '../dist/src/config.js';

/** Resolve only the selected configuration; never open daemon state or emit credentials. */
export async function resolveTunnelInstall(options = {}) {
  const configPath = await discoverConfigPath(options.config, { cwd: options.cwd, env: options.env, userHome: options.userHome });
  const config = await loadConfig(configPath, { workspaceDiagnostics: true });
  if (config.version !== 2 || !config.toolsDir || !path.isAbsolute(config.toolsDir)) {
    throw Object.assign(new Error('A unified v2 configuration is required for installation.'), { code: 'CONFIG_ERROR' });
  }
  const architecture = options.architecture ?? (process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined);
  if (!['amd64', 'arm64'].includes(architecture)) throw Object.assign(new Error('This installer supports amd64 and arm64 runtimes.'), { code: 'TUNNEL_ARCHITECTURE_UNSUPPORTED' });
  return { config_path: config.configPath, tools_dir: config.toolsDir, client_root: path.join(config.toolsDir, 'tunnel-client'), architecture, install_started: false };
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, architecture: { type: 'string' } }, allowPositionals: false });
    if (positionals.length) throw new Error();
    // ASCII JSON crosses Windows PowerShell 5.1 native-output code pages without
    // corrupting non-ASCII paths; JSON parsing restores their exact characters.
    process.stdout.write(JSON.stringify(await resolveTunnelInstall({ config: values.config, architecture: values.architecture }))
      .replace(/[^\x00-\x7f]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
  } catch (error) {
    const code = ['CONFIG_NOT_FOUND', 'CONFIG_AMBIGUOUS', 'CONFIG_ERROR', 'TUNNEL_ARCHITECTURE_UNSUPPORTED'].includes(error?.code) ? error.code : 'TUNNEL_INSTALL_CONFIG_ERROR';
    process.stderr.write(JSON.stringify({ ok: false, error: { code, message: 'Cannot resolve the selected unified configuration. Run config validate with the same configuration selection before installing.' } }) + '\n');
    process.exitCode = 1;
  }
}
