#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, writeFile, readFile, access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultUnifiedConfig, discoverConfigPath, loadConfig, validateConfig, resolveConfigSelectionPath } from './config.js';
import { App } from './app.js';
import { createMcpServer } from './server.js';
import { startHttp } from './http.js';
import { errorResult, AppError } from './errors.js';
import { addExecutable, addWorkspace, codexStatus, disableCodexSessions, enableCodexSessions, removeExecutable, removeWorkspace, setExecutionMode, setFullLocalAccess, showConfig } from './config-admin.js';
import { VERSION } from './version.js';
import { renameDevice, rebindWorkspace } from './config-admin.js';
import { setWorkspaceEnabled, workspaceHealthReport } from './config-admin.js';
import { workspaceHealth } from './workspace-health.js';
import { migrateConfiguration, writePrivateConfig } from './config-migration.js';
import { runTunnel, readTunnelStatus } from './tunnel.js';
import { configureExecutionPreset, inspectExecution } from './execution-admin.js';
import { createTunnelProgressReporter } from './tunnel-progress.js';
import { readMcpDiagnostics } from './mcp-diagnostics.js';
import { startLocalPanel, loadPanelViewConfig } from './local-panel.js';
import { PanelConfigService } from './panel-config.js';
import { PanelRuntime } from './panel-runtime.js';
import { startManagedPanel } from './panel-launcher.js';
import { readConfigDocument } from './config-admin.js';
import { inspectDocumentWidgetAsset } from './document-widget.js';
import { disableActionsProbe } from './config-admin.js';
import { createInterface } from 'node:readline/promises';
import { setupConfiguration, userConfigPath } from './setup.js';
import { checkLocalAccess } from './local-access.js';

const help=`WebCodex MCP ${VERSION} (Node >=22.16)
  setup  [--workspace PATH] [--config PATH] [--proxy URL] [--no-panel]
  init   [--workspace PATH] [--config PATH] [--no-tunnel]
  doctor [--config PATH]
  diagnostics show [--config PATH]
  serve  [--config PATH] [--transport stdio|http]
  config show [--config PATH]
  config validate [--config PATH]
  config migrate --output PATH [--legacy-auth PATH] [--legacy-connect PATH] [--apply] [--config PATH]
  config export --output PATH [--config PATH]
  device show [--config PATH]
  device rename --name NAME [--config PATH]
  workspace health [--config PATH]
  workspace disable --id ID [--config PATH]
  workspace enable --id ID [--config PATH]
  connect [--doctor-only] [--no-panel] [--config PATH]
  tunnel status [--config PATH]
  panel [--config PATH] [--port PORT]
  workspace rebind --id ID --root PATH [--name NAME] [--read-only] [--worktree] [--new-identity] [--config PATH]
  workspace list [--config PATH]
  workspace add --id ID --root ABSOLUTE_PATH [--name NAME] [--read-only] [--worktree] [--config PATH]
  workspace remove --id ID [--config PATH]
  execution set-mode disabled|trusted-host [--config PATH]
  execution add --alias NAME --executable ABSOLUTE_PATH [--prefix-arg VALUE ...] [--config PATH]
  execution remove --alias NAME [--config PATH]
  execution inspect [--config PATH]
  access full [--config PATH]
  access check [--config PATH]
  execution preset --preset node|npm|python|venv|conda [--alias NAME] [--command PATH] [--entry PATH] [--prefix PATH] [--config PATH]
  codex status [--config PATH]
  codex enable [--home ABSOLUTE_PATH] [--config PATH]
  codex disable [--config PATH]

New default: .webcodex/config.toml; JSON is also supported.
Select one file: --config > WEBCODEX_CONFIG > project > user. No merging.
Ambiguous TOML/JSON defaults are rejected. Secrets have no environment fallback.
config export generates a fresh template without local settings or credentials.
workspace rebind generates a new workspace UID when the root changes and preserves old records.
--new-identity also assigns a fresh UID to a replacement directory at the same pathname.
--worktree records verified Git metadata for an explicitly authorized linked worktree.
execution preset registers a native command without enabling execution.
New init/setup configurations allow writes in their workspace and all native commands with the current OS account.
setup installs missing local tools and prepares a private configuration, then opens the dashboard.
Existing configuration is preserved; --workspace only applies to new setup. --no-panel prepares and exits.
Config edits require a service restart; the local panel can restart its managed connection.
workspace remove never deletes files.
codex enable grants dedicated read-only tools access to local Codex session history.
Without --home, it preserves a configured home, then uses CODEX_HOME or ~/.codex.
trusted-host executes with the local owner's permissions; it is not an OS sandbox.
Use --prefix-arg=--flag for a fixed argument that begins with a hyphen.
stdio is recommended for OpenAI Secure MCP Tunnel.
v2 transport and HTTP bearer token are read from the selected configuration.
http binds only 127.0.0.1.
This local token is not a public ChatGPT OAuth implementation.
panel starts the local configuration and service dashboard on 127.0.0.1.
Its short-lived launch URL is printed once; keep it on this device.
connect starts the configured service and prints a private dashboard link in the terminal.
Use connect --no-panel for the original foreground tunnel lifecycle; --doctor-only never starts a dashboard.
The dashboard manages only connections it starts; older or --no-panel connections need a one-time handoff.
`;
async function main() {
  const {values,positionals,tokens}=parseArgs({allowPositionals:true,tokens:true,options:{proxy:{type:'string'},'expected-config-revision':{type:'string'},config:{type:'string'},port:{type:'string'},workspace:{type:'string'},transport:{type:'string'},help:{type:'boolean',short:'h'},id:{type:'string'},root:{type:'string'},name:{type:'string'},'read-only':{type:'boolean'},'new-identity':{type:'boolean'},worktree:{type:'boolean'},alias:{type:'string'},executable:{type:'string'},preset:{type:'string'},command:{type:'string'},entry:{type:'string'},prefix:{type:'string'},'prefix-arg':{type:'string',multiple:true},home:{type:'string'},output:{type:'string'},'legacy-auth':{type:'string'},'legacy-connect':{type:'string'},apply:{type:'boolean'},'doctor-only':{type:'boolean'},'no-panel':{type:'boolean'},'no-tunnel':{type:'boolean'}}});
  const options = tokens.filter(token => token.kind === 'option').map(token => token.name);
  for (const option of options) if (option !== 'prefix-arg' && options.filter(name => name === option).length > 1) throw new AppError('CLI_ERROR','Option --'+option+' may only be supplied once.');
  const command=positionals[0];
  if(values.help || !command){process.stdout.write(help);return;}
  const action = positionals[1];
  const key = ['workspace', 'execution', 'access', 'config', 'codex', 'device', 'tunnel', 'diagnostics', 'actions-probe'].includes(command) ? command+' '+(action??'') : command;
  const commandOptions: Record<string, { count:number; options:string[] }> = {
    setup:{count:1,options:['workspace','proxy','no-panel']},
    init:{count:1,options:['workspace','no-tunnel']},doctor:{count:1,options:[]},serve:{count:1,options:['transport','expected-config-revision']},
    'config show':{count:2,options:[]},'workspace list':{count:2,options:[]},
    'diagnostics show':{count:2,options:[]},
    connect:{count:1,options:['doctor-only','no-panel']},'tunnel status':{count:2,options:[]},
    panel:{count:1,options:['port']},'actions-probe disable':{count:2,options:[]},
    'config validate':{count:2,options:[]},'config export':{count:2,options:['output']},
    'config migrate':{count:2,options:['output','legacy-auth','legacy-connect','apply']},
    'device show':{count:2,options:[]},'device rename':{count:2,options:['name']},
    'workspace rebind':{count:2,options:['id','root','name','read-only','worktree','new-identity']},
    'workspace health':{count:2,options:[]},'workspace enable':{count:2,options:['id']},'workspace disable':{count:2,options:['id']},
    'workspace add':{count:2,options:['id','root','name','read-only','worktree']},'workspace remove':{count:2,options:['id']},
    'execution set-mode':{count:3,options:[]},'execution add':{count:2,options:['alias','executable','prefix-arg']},'execution remove':{count:2,options:['alias']},
    'execution inspect':{count:2,options:[]},'execution preset':{count:2,options:['preset','alias','command','entry','prefix']},
    'access full':{count:2,options:[]},'access check':{count:2,options:[]},
    'codex status':{count:2,options:[]},'codex enable':{count:2,options:['home']},'codex disable':{count:2,options:[]},
  };
  const spec = commandOptions[key];
  if (!spec) throw new AppError('CLI_ERROR','Unknown command. Use --help.');
  if(positionals.length!==spec.count)throw new AppError('CLI_ERROR','Unexpected or missing positional arguments. Use --help.');
  for (const option of options) if (!['config','help',...spec.options].includes(option)) throw new AppError('CLI_ERROR','Option --'+option+' is not supported by '+key+'.');
  const required = (name:'id'|'root'|'alias'|'executable'|'output'|'name') => {const value=values[name];if(!value)throw new AppError('CLI_ERROR',key+' requires --'+name+'.');return value;};
  const print = (result:unknown) => process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if (command === 'setup') {
    const result = await setupConfiguration({ config: values.config, workspace: values.workspace, proxyUrl: values.proxy,
      onProgress: message => process.stderr.write('[WebCodex] ' + message + '\n') });
    print(result.report);
    if (!values['no-panel']) {
      const listener = await startManagedPanel(result.config, { autoStart: false, fallbackPort: true, write: line => process.stderr.write(line) });
      installLocalPanelShutdown(listener.close);
      openSetupDashboard(listener.url);
    }
    return;
  }
  let configPath: string;
  try {
    configPath = command==='init' ? resolveConfigSelectionPath(values.config??process.env.WEBCODEX_CONFIG??'.webcodex/config.toml') : await discoverConfigPath(values.config);
  } catch (error) {
    // npm users commonly invoke `webcodex-mcp connect` from node_modules.
    // Bootstrap only connect (never arbitrary commands), and only when no
    // explicit config was selected. Existing files remain untouched.
    if (command === 'connect' && values.config === undefined && process.env.WEBCODEX_CONFIG === undefined && error instanceof AppError && error.code === 'CONFIG_NOT_FOUND') {
      const target = userConfigPath();
      const result = await setupConfiguration({ config: target, workspace: path.join(path.dirname(target), 'workspace'), onProgress: message => process.stderr.write('[WebCodex] ' + message + '\n') });
      process.stderr.write('[WebCodex] No configuration was found, so a new user configuration was created.\n');
      if (result.config) {
        const config = result.config;
        if (!values['no-panel']) {
          const listener = await startManagedPanel(config, { autoStart: false, fallbackPort: true, write: line => process.stderr.write(line) });
          installLocalPanelShutdown(listener.close);
          openSetupDashboard(listener.url);
          return;
        }
        configPath = target;
      } else throw error;
    } else throw error;
  }
  if(key==='config migrate'){print(await migrateConfiguration({source:configPath,output:resolveConfigSelectionPath(required('output')),legacyAuth:values['legacy-auth'],legacyConnect:values['legacy-connect'],apply:values.apply}));return;}
  if(key==='device rename'){print(await renameDevice(configPath,required('name')));return;}
  if(key==='workspace rebind'){print(await rebindWorkspace(configPath,{id:required('id'),root:required('root'),name:values.name,readOnly:values['read-only'],worktree:values.worktree,newIdentity:values['new-identity']}));return;}
  if(key==='workspace health'){print(await workspaceHealthReport(configPath));return;}
  if(key==='workspace enable'||key==='workspace disable'){print(await setWorkspaceEnabled(configPath,required('id'),key==='workspace enable'));return;}
  if(key==='config show'){print(await showConfig(configPath));return;}
  if(key==='workspace list'){const shown=await showConfig(configPath);print({ok:true,config:shown.config,workspaces:shown.workspaces});return;}
  if(key==='workspace add'){print(await addWorkspace(configPath,{id:required('id'),root:required('root'),name:values.name,readOnly:values['read-only'],worktree:values.worktree}));return;}
  if(key==='workspace remove'){print(await removeWorkspace(configPath,required('id')));return;}
  if(key==='execution set-mode'){print(await setExecutionMode(configPath,positionals[2]));return;}
  if(key==='execution add'){print(await addExecutable(configPath,{alias:required('alias'),command:required('executable'),args:values['prefix-arg']??[]}));return;}
  if(key==='execution remove'){print(await removeExecutable(configPath,required('alias')));return;}
  if(key==='access full'){print(await setFullLocalAccess(configPath));return;}
  if(key==='access check'){print(await checkLocalAccess(await loadConfig(configPath,{workspaceDiagnostics:true})));return;}
  if(key==='execution preset'){
    const preset=values.preset;
    if(preset!=='node'&&preset!=='npm'&&preset!=='python'&&preset!=='venv'&&preset!=='conda')throw new AppError('CLI_ERROR','execution preset requires --preset node|npm|python|venv|conda.');
    print(await configureExecutionPreset(configPath,{preset,alias:values.alias,command:values.command,entry:values.entry,prefix:values.prefix}));return;
  }
  if(key==='codex status'){print(await codexStatus(configPath));return;}
  if(key==='codex enable'){print(await enableCodexSessions(configPath,values.home));return;}
  if(key==='codex disable'){print(await disableCodexSessions(configPath));return;}
  if(command==='init'){
    const workspacePath=path.resolve(values.workspace ?? path.join(process.cwd(),'workspace'));
    await mkdir(workspacePath,{recursive:true});
    const root=await realpath(workspacePath);
    if(!values.config&&!process.env.WEBCODEX_CONFIG){try{await access(path.resolve('.webcodex/config.json'));throw new AppError('CONFIG_EXISTS','An existing JSON configuration was found. Migrate it explicitly.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    const raw=defaultUnifiedConfig(root,configPath,{fullLocalAccess:true});
    raw.http.bearerToken=randomBytes(32).toString('hex');
    if (!values['no-tunnel']) await configureTunnelCredentials(raw);
    await validateConfig(raw,configPath);
    await writePrivateConfig(configPath,raw);
    process.stdout.write(JSON.stringify({ok:true,config:configPath,workspace:root,workspace_access:'read-write',execution_mode:'trusted-host',command_policy:'all'},null,2)+'\n');return;
  }
  if(key==='diagnostics show'){const config=await loadConfig(configPath,{workspaceDiagnostics:true});print({ok:true,...readMcpDiagnostics(config)});return;}
  if(key==='actions-probe disable'){print(await disableActionsProbe(configPath));return;}
  if(command==='panel'){
    const config=await loadPanelViewConfig(configPath);
    const port = values.port === undefined ? undefined : Number(values.port);
    if (port !== undefined && (!/^\d+$/.test(values.port!) || !Number.isInteger(port) || port < 1024 || port > 65535)) throw new AppError('CLI_ERROR','Use a local panel port from 1024 to 65535.');
    const manager = new PanelRuntime(configPath);
    const listener=await startLocalPanel(config,{port,management:{config:new PanelConfigService(configPath),runtime:manager}});
    installLocalPanelShutdown(async()=>{await manager.close();await listener.close();});
    print({ok:true,url:listener.url,local_only:true,management:true,notice:'Open this private local dashboard to edit configuration and manage its connection. Keep this process running.'});
    return;
  }
  const panelChild = command === 'serve' && process.connected && process.env.WEBCODEX_PANEL_CONFIG_REVISION !== undefined;
  let panelStopRequested = false;
  let panelShutdown: (() => Promise<void>) | undefined;
  const panelStop = async () => {
    panelStopRequested = true;
    if (!panelShutdown) return;
    await panelShutdown();
    if (process.connected) process.disconnect();
  };
  if (panelChild) {
    process.on('message', message => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'webcodex_panel_shutdown') void panelStop().catch(() => { process.exitCode = 1; });
    });
    process.once('disconnect', () => { void panelStop().catch(() => { process.exitCode = 1; }); });
  }
  const config = await (async () => {
    const expectedRevision = values['expected-config-revision'] ?? (panelChild ? process.env.WEBCODEX_PANEL_CONFIG_REVISION : undefined);
    if (expectedRevision === undefined) return loadConfig(configPath);
    const revision = expectedRevision;
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new AppError('CONFIG_CONFLICT','Invalid managed configuration revision.');
    const document = await readConfigDocument(configPath);
    if (document.revision !== revision) throw new AppError('CONFIG_CONFLICT','Configuration changed before service startup. Reload and start again.');
    const loaded = await validateConfig(document.raw, document.fullPath);
    if (panelChild && loaded.server?.transport !== 'http') throw new AppError('CONFIG_ERROR','The managed IPC launcher requires HTTP transport.');
    return loaded;
  })();
  if (panelChild && (panelStopRequested || !process.connected)) { if (process.connected) process.disconnect(); return; }
  if(key==='execution inspect'){print(await inspectExecution(config));return;}
  if(key==='config validate'){print({ok:true,config:configPath,version:config.version,device_id:config.device?.id??null});return;}
  if(key==='device show'){print({ok:true,device:config.device??null,platform:process.platform,legacy:config.version===1});return;}
  if(key==='config export'){
    const output=resolveConfigSelectionPath(required('output'));
    const raw=defaultUnifiedConfig('./workspace',output,{deviceName:'My device'});
    raw.device.id='';raw.workspaces[0].uid='';
    raw.workspaces[0].root='./workspace';raw.nodePath='auto';raw.rgPath='auto';raw.gitPath='auto';raw.codexSessions.home='${userHome}/.codex';raw.http.bearerToken='';
    await writePrivateConfig(output,raw);print({ok:true,output,template:true,notice:'Identities and credentials are blank. Run init on each device to generate its local identities, then transfer desired non-secret settings.'});return;
  }
  if(key==='tunnel status'){const result=await readTunnelStatus(config);print(result);process.exitCode=result.exit_code;return;}
  if(command==='connect'){
    if (config.version === 2 && !values['doctor-only'] && !values['no-panel']) {
      const listener = await startManagedPanel(config, { autoStart: true, fallbackPort: true, write: line => process.stderr.write(line) });
      installLocalPanelShutdown(listener.close);
      return;
    }
    const progress=createTunnelProgressReporter(line=>process.stderr.write(line));
    try {
      const result=await runTunnel(config,{doctorOnly:values['doctor-only'],onProgress:event=>event.type==='phase'?progress.phase(event.phase):progress.observe(event.status)});
      print({ok:result.exit_code===0,...result});process.exitCode=result.exit_code;return;
    } catch(error){progress.failed(error instanceof AppError?error.code:undefined);throw error;}
  }
  if(command==='doctor'){
    const [git,rgProbe]=await Promise.all([probe(config.gitPath??'git',['--version']),probe(config.rgPath,['--version'])]);
    const rg={...rgProbe,configured_path:config.rgPath,...(!rgProbe.available?{remediation:'Install ripgrep or set rgPath in the configuration to the absolute path of an installed rg.exe (rg on other platforms). The tunnel process must be able to run that executable.'}:{})};
    const workspaces=await Promise.all(config.workspaces.map(async w=>{const health=workspaceHealth(config,w);let writable=false;if(health.available&&!w.readOnly)try{await access(w.root,constants.W_OK);writable=true;}catch{}return{workspace_id:w.id,exists:health.available?true:health.status==='missing'?false:null,enabled:w.enabled!==false,read_only:w.readOnly,writable,...health};}));
    const local_access = await checkLocalAccess(config);
    let document_widget: {ok:boolean;[key:string]:unknown};
    try { document_widget={ok:true,...inspectDocumentWidgetAsset()}; }
    catch { document_widget={ok:false,code:'DOCUMENT_WIDGET_ASSET_INVALID',remediation:'Run npm run build successfully before restarting this release.'}; }
    const result={ok:git.available && rg.available && document_widget.ok,version:VERSION,device:config.device,node:process.version,mcp_sdk:'1.30.0',git,rg,workspaces,local_access,document_widget,execution_mode:config.execution.mode,execution_command_policy:config.execution.commandPolicy??'allowlist',all_native_programs:config.execution.mode==='trusted-host'&&(config.execution.commandPolicy??'allowlist')==='all',executable_aliases:Object.keys(config.execution.allowedExecutables),connection:'Local checks only; ChatGPT negotiation must be verified separately.',config:configPath};
    process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.ok)process.exitCode=1;return;
  }
  const transport=config.version===2?(config.server?.transport??'stdio'):(values.transport??'stdio');
  if(config.version===2&&values.transport&&values.transport!==transport)throw new AppError('CONFIG_ERROR','Set server.transport in the selected configuration; conflicting overrides are rejected.');
  if(transport!=='stdio' && transport!=='http')throw new AppError('CLI_ERROR','transport must be stdio or http.');
  const app=new App(config);
  let cleanupTransport=async()=>{};
  let shutdownPromise: Promise<void> | undefined;
  const shutdown=()=>shutdownPromise??=(async()=>{try{await cleanupTransport();}finally{await app.close();}})();
  process.once('SIGINT',()=>{void shutdown().then(()=>{process.exitCode=0;});});
  process.once('SIGTERM',()=>{void shutdown().then(()=>{process.exitCode=0;});});
  try { if(transport==='stdio'){
    const server=createMcpServer(app);
    await server.connect(new StdioServerTransport());
    cleanupTransport=()=>server.close();
    server.server.onclose=()=>{void shutdown();};
    process.stdin.once('end',()=>{void shutdown();});
    process.stderr.write('WebCodex MCP ready on stdio; execution='+config.execution.mode+'\n');
  }else{
    const tokenPath=path.join(config.stateDir,'http-token');
    let token=config.http.bearerToken;
    if(config.version===1){try{token=(await readFile(tokenPath,'utf8')).trim();}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;token=randomBytes(32).toString('hex');await writeFile(tokenPath,token+'\n',{flag:'wx',mode:0o600});}}
    if(!token)throw new AppError('CONFIG_ERROR','Configure http.bearerToken before enabling HTTP.');
    const listener=await startHttp(app,{token});
    cleanupTransport=listener.close;
    process.stderr.write('WebCodex MCP ready at '+listener.url+'; bearer token loaded locally.\n');
    if (panelChild) {
      panelShutdown = shutdown;
      if (panelStopRequested || !process.connected) await panelStop();
      else process.send?.({type:'webcodex_panel_ready'}, () => {});
    }
  }
  } catch(error) { await shutdown(); throw error; }
}
function openSetupDashboard(url: string) {
  const notice = () => process.stderr.write('[WebCodex] Browser could not be opened automatically. Open the private dashboard link printed above.\n');
  try {
    // Pass the local launch credential as data, never interpolate it into shell source.
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (process.platform === 'win32' && (!systemRoot || !path.win32.isAbsolute(systemRoot))) { notice(); return; }
    const command = process.platform === 'win32' ? path.join(systemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env.WEBCODEX_SETUP_URL'] : [url];
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBCODEX_SETUP_URL: url } });
    const timer = setTimeout(() => { child.kill(); notice(); }, 10000);
    timer.unref();
    child.once('error', () => { clearTimeout(timer); notice(); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0) notice(); });
  } catch { notice(); }
}

/**
 * Show an official page during interactive init.
 *
 * The URL is deliberately only printed.  The user opens it, creates or
 * selects the credential, and pastes the value back into this terminal.  We
 * do not inspect the page, launch a browser on the user's behalf, or send a
 * credential through an automation channel.  This also makes the same flow
 * work over SSH and on headless machines.
 */
function showOfficialLink(url: string, label: string) {
  process.stderr.write(`[WebCodex] ${label}\n`);
  process.stderr.write(`           ${url}\n`);
  process.stderr.write('[WebCodex] 请在浏览器中打开上面的链接，完成操作后回到此终端粘贴结果。\n');
}

async function readSecretPrompt(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    const rl = createInterface({ input, output: process.stderr });
    try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
  }
  process.stderr.write(prompt);
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const onData = (chunk: Buffer | string) => {
      const text = String(chunk);
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          input.setRawMode?.(false); input.pause(); input.off('data', onData);
          process.stderr.write('\n'); resolve(value.trim()); return;
        }
        if (char === '\u0003') { input.setRawMode?.(false); input.pause(); input.off('data', onData); reject(new AppError('CLI_CANCELLED', 'Initialization was cancelled.')); return; }
        if (char === '\u0008' || char === '\u007f') value = value.slice(0, -1); else if (char >= ' ') value += char;
      }
    };
    input.setEncoding('utf8'); input.on('data', onData); input.setRawMode?.(true); input.resume();
  });
}

async function configureTunnelCredentials(raw: ReturnType<typeof defaultUnifiedConfig>) {
  if (!process.stdin.isTTY) {
    process.stderr.write('[WebCodex] 非交互终端，跳过 Tunnel 配置；可稍后运行 panel 修改。\n');
    return;
  }
  showOfficialLink('https://platform.openai.com/settings/organization/tunnels', '请打开官方 Tunnel 页面，创建或查看 Tunnel');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let tunnelId = '';
  try { tunnelId = (await rl.question('Tunnel ID（留空则跳过隧道）：')).trim(); } finally { rl.close(); }
  if (!tunnelId) return;
  showOfficialLink('https://platform.openai.com/api-keys', '请打开官方 API keys 页面，创建 API key');
  const apiKey = await readSecretPrompt('API key（输入时不回显）：');
  if (!apiKey) throw new AppError('CLI_ERROR', '已输入 Tunnel ID，但 API key 为空；请重新运行 init 或使用 panel 配置。');
  raw.tunnel = { ...raw.tunnel, enabled: true, id: tunnelId, apiKey };
  process.stderr.write('[WebCodex] Tunnel 凭据已写入本机配置（密钥不会显示）。\n');
}
function installLocalPanelShutdown(close:()=>Promise<void>) {
  let stopping=false;
  const shutdown=async()=>{
    if(stopping)return;
    stopping=true;
    try {await close();process.exitCode??=0;}
    catch {stopping=false;process.stderr.write(JSON.stringify(errorResult(new AppError('LOCAL_PANEL_SHUTDOWN_FAILED','The local panel is still open. Wait for active jobs to finish and stop its connection from the dashboard, then retry.')))+'\n');}
  };
  const onSignal=()=>{void shutdown();};
  process.on('SIGINT',onSignal);
  process.on('SIGTERM',onSignal);
}
async function probe(command:string,args:string[]) {
  return await new Promise<{available:boolean;version?:string}>(resolve=>{
    let done=false;let output='';
    const proc=spawn(command,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','ignore']});
    const finish=(available:boolean)=>{if(done)return;done=true;clearTimeout(timer);resolve({available,...(available?{version:output.split(/\r?\n/)[0].slice(0,150)}:{})});};
    const timer=setTimeout(()=>{proc.kill();finish(false);},5000);
    proc.stdout.on('data',(b:Buffer)=>{if(output.length<2048)output+=b.toString('utf8');});
    proc.on('error',()=>finish(false));proc.on('close',code=>finish(code===0));
  });
}
main().catch(error=>{
  const failure = typeof error?.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_')
    ? new AppError('CLI_ERROR', 'Invalid command-line arguments. Use --help.') : error;
  process.stderr.write(JSON.stringify(errorResult(failure))+'\n');process.exitCode=1;
  if (process.connected && process.env.WEBCODEX_PANEL_CONFIG_REVISION !== undefined) {
    const code = failure instanceof AppError && ['CONFIG_CONFLICT','CONFIG_ERROR','HTTP_START_FAILED'].includes(failure.code) ? failure.code : 'PANEL_RUNTIME_FAILED';
    process.send?.({type:'webcodex_panel_failed',code}, () => { if (process.connected) process.disconnect(); });
  }
});
