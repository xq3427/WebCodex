import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, writeFile, readFile, rm, access, symlink, realpath } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultConfig, defaultUnifiedConfig } from '../src/config.js';
import { runTunnel, readTunnelStatus } from '../src/tunnel.js';
import { AppError } from '../src/errors.js';
import { createServer } from 'node:http';

const fakeKey = 'synthetic-unified-config-key';
type LaunchConfig = Parameters<typeof runTunnel>[0];

async function fixture() {
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'webcodex-tunnel-test-'));
  const project = path.join(base, "project with spaces and apostrophe's");
  const configDir = path.join(project, '.webcodex');
  const toolsDir = path.join(base, 'device tools');
  const clientRoot = path.join(toolsDir, 'tunnel-client');
  await mkdir(configDir, { recursive: true });
  await mkdir(clientRoot, { recursive: true });
  // The extensionless doctor/run and compatibility CLI fixtures use CommonJS.
  // Keep that interpretation when TEMP sits in a type:module repository.
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const client = path.join(clientRoot, process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client');
  // A copied native Node binary interprets the local doctor/run fixture files.
  // It never invokes the actual official tunnel binary or any network endpoint.
  await copyFile(process.execPath, client);
  const sha256 = createHash('sha256').update(await readFile(client)).digest('hex');
  const configPath = path.join(configDir, 'config.json');
  const config = {
    ...defaultConfig(project, configPath), configPath, stateDir: path.join(base, 'device state'), toolsDir,
    nodePath: process.execPath, server: { transport: 'stdio' },
    tunnel: { enabled: true, id: 'tunnel_synthetic_fixture', apiKey: fakeKey, proxyUrl: '', clientPath: 'auto', clientVersion: 'auto' },
  } as LaunchConfig;
  await writeFile(configPath, JSON.stringify(config));
  const installPath = path.join(clientRoot, 'install.json');
  const installation = {
    version: 'v0.0.14', releaseUrl: 'https://github.com/openai/tunnel-client/releases/tag/v0.0.14',
    architecture: process.arch === 'x64' ? 'amd64' : process.arch, platform: process.platform,
    executable: client, executableSha256: sha256,
  };
  await writeFile(installPath, JSON.stringify(installation));
  const observations = path.join(configDir, 'observations.jsonl');
  const optionsPath = path.join(configDir, 'fixture-options.json');
  const options = { doctorExit: 0, runExit: 0, expectedKey: fakeKey };
  await writeFile(optionsPath, JSON.stringify(options));
  const program = `
const fs = require('node:fs');
const path = require('node:path');
const options = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-options.json'), 'utf8'));
const args = process.argv.slice(2);
const get = name => args[args.indexOf(name) + 1];
const verb = path.basename(process.argv[1]);
const observation = { verb, args, keyMatched: process.env.CONTROL_PLANE_API_KEY === options.expectedKey,
  leakedSettings: Object.keys(process.env).filter(name => /^(?:CONTROL_PLANE_|MCP_|HARPOON_|LOG_|OPENAI_API_KEY$|NODE_OPTIONS$|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(name) && name !== 'CONTROL_PLANE_API_KEY') };
fs.appendFileSync(path.join(__dirname, 'observations.jsonl'), JSON.stringify(observation) + '\\n');
// Simulate an unsafe third-party diagnostic; the launcher must never relay it.
process.stdout.write(options.expectedKey);
process.stderr.write(options.expectedKey);
if (verb === 'run' && options.runHealthy) {
  const started = new Date().toISOString();
  const server = require('node:http').createServer((req,res) => {
    if(req.url === '/healthz') res.end('live');
    else if(req.url === '/readyz') res.end('ready');
    else if(req.url === '/api/status') res.end(JSON.stringify({started_at:started,control_plane_tunnel_id:get('--control-plane.tunnel-id'),channels:[{name:'main',enabled:true,probe_status:'ok'}],error:options.expectedKey}));
    else res.end('liveness 1\\nreadiness 1\\ncommands_poll_last_successful_timestamp_seconds '+Date.now()/1000+'\\n');
  });
  server.listen(0,'127.0.0.1',()=>fs.writeFileSync(get('--health.url-file'),'http://127.0.0.1:'+server.address().port+'\\n'));
  setTimeout(()=>server.close(()=>process.exit(options.runExit)),3000);
} else {
  if (verb === 'run') fs.writeFileSync(get('--health.url-file'), 'http://127.0.0.1:65534\\n');
  process.exit(verb === 'doctor' ? options.doctorExit : options.runExit);
}
`;
  await writeFile(path.join(configDir, 'doctor'), program);
  await writeFile(path.join(configDir, 'run'), program);
  return {
    base, configDir, config, client, sha256, installPath, installation, optionsPath, options,
    records: async () => (await readFile(observations, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    clean: async () => { assert.match(path.basename(base), /^webcodex-tunnel-test-/); await rm(base, { recursive: true, force: true }); },
  };
}

test('unified tunnel config controls argv and child environment with a quoted stdio MCP target', async () => {
  const f = await fixture();
  const poisoned = ['CONTROL_PLANE_API_KEY', 'CONTROL_PLANE_TUNNEL_ID', 'CONTROL_PLANE_BASE_URL', 'MCP_COMMAND', 'MCP_SERVER_URL', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_OPTIONS', 'LOG_HTTP_RAW_UNSAFE'];
  const previous = new Map(poisoned.map(name => [name, process.env[name]]));
  try {
    for (const name of poisoned) process.env[name] = 'synthetic-legacy-value';
    const result = await runTunnel(f.config);
    assert.equal(result.exit_code, 0);
    assert.equal(result.doctor_only, false);
    assert.equal(result.client_source, 'official_release_record');
    assert.equal(result.health_url_file, path.join(f.config.stateDir, 'tunnel', 'health.url'));
    const records = await f.records();
    assert.deepEqual(records.map(item => item.verb), ['doctor', 'run']);
    for (const record of records) {
      assert.equal(record.keyMatched, true);
      assert.deepEqual(record.leakedSettings, []);
      assert.ok(!JSON.stringify(record).includes(fakeKey));
      const at = (name: string) => record.args[record.args.indexOf(name) + 1];
      assert.equal(at('--control-plane.api-key'), 'env:CONTROL_PLANE_API_KEY');
      assert.equal(at('--control-plane.tunnel-id'), 'tunnel_synthetic_fixture');
      assert.equal(at('--control-plane.base-url'), 'https://api.openai.com');
      assert.equal(at('--health.listen-addr'), '127.0.0.1:0');
      assert.ok(record.args.includes('--log.http-raw-unsafe=false'));
      assert.ok(!record.args.includes('--control-plane.http-proxy'));
      const command = at('--mcp.command');
      const expectedPath = process.platform === 'win32' ? f.config.configPath.replace(/\\/g, '/') : f.config.configPath;
      assert.ok(command.includes(`--config "${expectedPath}"`));
      assert.ok(command.endsWith('--transport stdio'));
    }
    for (const name of poisoned) assert.equal(process.env[name], 'synthetic-legacy-value');
    await assert.rejects(access(path.join(f.config.stateDir, 'tunnel', 'launcher.lock')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(f.config.stateDir, 'state.sqlite')), { code: 'ENOENT' });
  } finally {
    for (const [name, value] of previous) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await f.clean();
  }
});

test('explicit native client outside tools is hash-pinned and doctor-only never starts run', async () => {
  const f = await fixture();
  try {
    const explicit = path.join(f.base, process.platform === 'win32' ? 'external client.exe' : 'external client');
    await copyFile(f.client, explicit);
    f.config.tunnel = { ...f.config.tunnel!, clientPath: explicit, clientSha256: f.sha256, proxyUrl: 'http://127.0.0.1:12345' };
    const result = await runTunnel(f.config, { doctorOnly: true });
    assert.equal(result.client_source, 'configured_sha256');
    assert.equal(result.doctor_only, true);
    const [record] = await f.records();
    assert.equal(record.verb, 'doctor');
    assert.equal((await f.records()).length, 1);
    assert.ok(record.args.includes('http://127.0.0.1:12345'));
    f.config.tunnel.clientSha256 = '0'.repeat(64);
    await assert.rejects(runTunnel(f.config, { doctorOnly: true }), { code: 'TUNNEL_CLIENT_INVALID' });
  } finally { await f.clean(); }
});

test('doctor-only emits validation phases without claiming connectivity; observer errors cannot break cleanup', async () => {
  const f=await fixture();
  try {
    const events:Array<unknown>=[];
    await runTunnel(f.config,{doctorOnly:true,onProgress:event=>events.push(event)});
    assert.deepEqual(events,[{type:'phase',phase:'checking'},{type:'phase',phase:'doctor'},{type:'phase',phase:'validated'}]);
    const result=await runTunnel(f.config,{doctorOnly:true,onProgress:()=>{throw new Error(fakeKey);}});
    assert.equal(result.exit_code,0);
    await assert.rejects(access(path.join(f.config.stateDir,'tunnel','launcher.lock')),{code:'ENOENT'});
  } finally {await f.clean();}
});

test('CLI reports observed startup connectivity without relaying client secrets or waiting for a ChatGPT call', async () => {
  const f=await fixture();
  try {
    const raw={...defaultUnifiedConfig(f.config.workspaces[0].root,f.config.configPath),stateDir:f.config.stateDir,toolsDir:f.config.toolsDir,nodePath:process.execPath,tunnel:f.config.tunnel};
    await writeFile(f.config.configPath,JSON.stringify(raw));
    await writeFile(f.optionsPath,JSON.stringify({...f.options,runHealthy:true}));
    const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
    const result=await new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{
      const child=spawn(process.execPath,[cli,'connect','--config',f.config.configPath],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      let out='',err='';const timer=setTimeout(()=>{child.kill();reject(new Error('Synthetic CLI startup exceeded its deadline.'));},15000);
      child.stdout.on('data',data=>{out+=data.toString();});child.stderr.on('data',data=>{err+=data.toString();});
      child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);resolve({code,out,err});});
    });
    assert.equal(result.code,0,result.err);
    assert.equal(JSON.parse(result.out).ok,true);
    assert.match(result.err,/Checking local configuration/);
    assert.match(result.err,/Checking tunnel client compatibility/);
    assert.match(result.err,/Connected; local MCP is ready/);
    assert.match(result.err,/No successful ChatGPT tool call has been observed yet/);
    assert.match(result.err,/Keep this terminal open/);
    assert.match(result.err,/Tunnel stopped/);
    assert.equal((result.err.match(/Connected;/g)??[]).length,1);
    assert.equal((result.out+result.err).includes(fakeKey),false);
    await assert.rejects(access(path.join(f.config.stateDir,'tunnel','launcher.lock')),{code:'ENOENT'});
  } finally {await f.clean();}
});

test('installation metadata rejects wrong origin, version, hash and paths before a client starts', async () => {
  const f = await fixture();
  try {
    const cases = [
      { releaseUrl: 'https://example.invalid/tunnel-client/releases/tag/v0.0.14' },
      { executableSha256: '0'.repeat(64) }, { version: '../bad' },
      { architecture: 'not-this-device' }, { platform: 'not-this-platform' },
      { executable: process.execPath },
    ];
    for (const patch of cases) {
      await writeFile(f.installPath, JSON.stringify({ ...f.installation, ...patch }));
      await assert.rejects(runTunnel(f.config, { doctorOnly: true }), { code: 'TUNNEL_CLIENT_INVALID' });
    }
    await writeFile(f.installPath, JSON.stringify(f.installation));
    f.config.tunnel!.clientVersion = 'v9.9.9';
    await assert.rejects(runTunnel(f.config), { code: 'TUNNEL_CLIENT_INVALID' });
    await assert.rejects(f.records(), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('missing unified key never falls back to environment and invalid values fail without disclosure', async () => {
  const f = await fixture();
  const previous = process.env.CONTROL_PLANE_API_KEY;
  try {
    process.env.CONTROL_PLANE_API_KEY = 'synthetic-environment-key';
    const original = { ...f.config.tunnel! };
    for (const patch of [{ apiKey: '' }, { apiKey: 'synthetic\nkey' }, { id: 'bad-id' }, { proxyUrl: 'http://user:synthetic@localhost:1234' }, { proxyUrl: 'http://localhost:1234/path' }]) {
      f.config.tunnel = { ...original, ...patch };
      await assert.rejects(runTunnel(f.config), (error: unknown) => error instanceof AppError && error.code === 'TUNNEL_CONFIG_INVALID' && !error.message.includes('synthetic'));
    }
    f.config.tunnel = original;
    f.config.server = { transport: 'http' };
    await assert.rejects(runTunnel(f.config), { code: 'TUNNEL_TRANSPORT_INVALID' });
    f.config.server = { transport: 'stdio' };
    f.config.tunnel = undefined;
    await assert.rejects(runTunnel(f.config), { code: 'TUNNEL_DISABLED' });
    await assert.rejects(f.records(), { code: 'ENOENT' });
    assert.equal(process.env.CONTROL_PLANE_API_KEY, 'synthetic-environment-key');
  } finally { if (previous === undefined) delete process.env.CONTROL_PLANE_API_KEY; else process.env.CONTROL_PLANE_API_KEY = previous; await f.clean(); }
});

test('client failures do not print raw key diagnostics and release their control lock', async () => {
  const f = await fixture();
  try {
    await writeFile(f.optionsPath, JSON.stringify({ ...f.options, doctorExit: 7 }));
    await assert.rejects(runTunnel(f.config), (error: unknown) => error instanceof AppError && error.code === 'TUNNEL_DOCTOR_FAILED' && !JSON.stringify(error).includes(fakeKey));
    assert.deepEqual((await f.records()).map(item => item.verb), ['doctor']);
    await assert.rejects(access(path.join(f.config.stateDir, 'tunnel', 'launcher.lock')), { code: 'ENOENT' });
    await writeFile(f.optionsPath, JSON.stringify({ ...f.options, runExit: 9 }));
    await assert.rejects(runTunnel(f.config), { code: 'TUNNEL_EXITED' });
    await assert.rejects(access(path.join(f.config.stateDir, 'tunnel', 'launcher.lock')), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('an existing launcher lock and a linked state path are never overwritten', async () => {
  const f = await fixture();
  try {
    const control = path.join(f.config.stateDir, 'tunnel');
    await mkdir(control, { recursive: true });
    const lock = path.join(control, 'launcher.lock');
    await writeFile(lock, 'synthetic-existing-owner');
    await assert.rejects(runTunnel(f.config), { code: 'TUNNEL_ALREADY_RUNNING' });
    assert.equal(await readFile(lock, 'utf8'), 'synthetic-existing-owner');
    const linked = path.join(f.base, 'linked state');
    await symlink(f.config.stateDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
    f.config.stateDir = linked;
    await assert.rejects(runTunnel(f.config), { code: 'TUNNEL_PATH_INVALID' });
    await assert.rejects(f.records(), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('launcher lock permission and I/O failures are not reported as an existing connection', async t => {
  const f = await fixture();
  const originalOpen = fsPromises.open;
  const lockFile = path.join(f.config.stateDir, 'tunnel', 'launcher.lock');
  let failureCode = 'EACCES';
  const mocked = t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === lockFile) throw Object.assign(new Error(fakeKey), { code: failureCode });
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    for (const code of ['EACCES', 'EPERM', 'EIO']) {
      failureCode = code;
      await assert.rejects(runTunnel(f.config), (error: unknown) => error instanceof AppError &&
        error.code === 'TUNNEL_CONTROL_UNAVAILABLE' && !error.message.includes(fakeKey));
    }
    await assert.rejects(access(lockFile), { code: 'ENOENT' });
    await assert.rejects(f.records(), { code: 'ENOENT' });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await f.clean();
  }
});

test('PowerShell v2 compatibility entry discovers TOML or JSON and never loads legacy auth', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  try {
    const project = path.join(f.base, 'compatibility');
    await mkdir(path.join(project, 'scripts'), { recursive: true });
    await mkdir(path.join(project, 'dist', 'src'), { recursive: true });
    const launcher = path.join(project, 'scripts', 'start-tunnel.ps1');
    await copyFile(fileURLToPath(new URL('../../scripts/start-tunnel.ps1', import.meta.url)), launcher);
    const observed = path.join(project, 'arguments.json');
    await writeFile(path.join(project, 'dist', 'src', 'cli.js'), `require('node:fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.argv.slice(2)));`);
    const modern = path.join(project, 'unified.json');
    await writeFile(modern, JSON.stringify({ version: 2, nodePath: process.execPath, tunnel: { apiKey: fakeKey } }));
    const invoke = (args: string[], selected?: string) => new Promise<number | null>((resolve, reject) => {
      const env = { ...process.env };
      delete env.WEBCODEX_CONFIG;
      if (selected) env.WEBCODEX_CONFIG = selected;
      const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, ...args], { env, windowsHide: true, shell: false, stdio: 'ignore' });
      proc.once('error', reject); proc.once('close', resolve);
    });
    assert.equal(await invoke(['-Config', modern, '-DoctorOnly', '-NoPrompt']), 0);
    assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), ['connect', '--config', modern, '--doctor-only']);
    const localNode = path.join(project, 'configured-node.exe');
    await copyFile(process.execPath, localNode);
    await writeFile(modern, JSON.stringify({ version: 2, nodePath: '${configDir}/configured-node.exe', tunnel: { apiKey: fakeKey } }));
    assert.equal(await invoke(['-Config', modern]), 0);
    assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), ['connect', '--config', modern]);
    const modernDirectory = path.join(project, '.webcodex');
    await mkdir(modernDirectory);
    const toml = path.join(modernDirectory, 'config.toml');
    await writeFile(toml, `version = 2\n[tunnel]\napiKey = "${fakeKey}"\n`);
    assert.equal(await invoke(['-DoctorOnly']), 0);
    assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), ['connect', '--config', toml, '--doctor-only']);
    assert.equal(await invoke([], modern), 0);
    assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), ['connect', '--config', modern]);
    await writeFile(path.join(modernDirectory, 'config.json'), JSON.stringify({ version: 2 }));
    assert.notEqual(await invoke([]), 0);
    assert.notEqual(await invoke(['-Config', toml, '-TunnelId', 'tunnel_override']), 0);
    assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), ['connect', '--config', modern]);
    await assert.rejects(access(path.join(project, 'scripts', 'tunnel-auth.ps1')), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('Node health reader uses bounded loopback probes, fresh polls and redacted metadata', async () => {
  const f = await fixture();
  let stale = false;
  let redirect = false;
  let requests = 0;
  const started = new Date().toISOString();
  const server = createServer((req, res) => {
    requests++;
    if (redirect) { res.writeHead(302, { location: 'http://example.invalid/private' }); res.end(); return; }
    if (req.url === '/healthz') res.end('live');
    else if (req.url === '/readyz') res.end('ready');
    else if (req.url === '/api/status') res.end(JSON.stringify({
      started_at: started, control_plane_tunnel_id: f.config.tunnel!.id,
      control_plane_route: { route_mode: 'proxy', proxy_url: 'http://synthetic-user:synthetic-key@127.0.0.1:1234' },
      channels: [{ name: 'main', enabled: true, probe_status: 'ok' }],
    }));
    else res.end(`liveness 1\nreadiness 1\ncommands_poll_last_successful_timestamp_seconds ${Date.now() / 1000 - (stale ? 180 : 1)}\n` +
      'command_end_to_end_latency_milliseconds_count{latency_type="enqueue_to_response",request_method="tools/call",tunnel_service_status="200"} 3\n');
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const control = path.join(f.config.stateDir, 'tunnel');
    await mkdir(control, { recursive: true });
    await writeFile(path.join(control, 'launcher.lock'), JSON.stringify({ pid: process.pid, owner: 'fixture', started_at: started }));
    const health = path.join(control, 'health.url');
    await writeFile(health, `http://127.0.0.1:${port}\n`);
    const status = await readTunnelStatus(f.config);
    assert.equal(status.state, 'connected_tools_called');
    assert.equal(status.successful_tool_calls, 3);
    assert.equal(status.process_identity_verified, false);
    assert.equal(status.route_mode, 'proxy');
    assert.ok(!JSON.stringify(status).includes('synthetic-key'));
    assert.ok(!JSON.stringify(status).includes(f.config.tunnel!.id));
    stale = true;
    assert.equal((await readTunnelStatus(f.config)).state, 'poll_not_fresh');
    redirect = true;
    assert.equal((await readTunnelStatus(f.config)).state, 'diagnostics_unavailable');
    assert.equal(requests, 12);
    await writeFile(health, 'http://example.invalid:1234');
    assert.equal((await readTunnelStatus(f.config)).state, 'unsafe_health_url');
    assert.equal(requests, 12);
    await assert.rejects(readTunnelStatus(f.config, { timeoutMs: 30001 }), { code: 'INVALID_ARGUMENT' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.clean(); }
});
