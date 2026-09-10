import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, lstat, rmdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { defaultUnifiedConfig, loadConfig, validateConfig } from '../src/config.js';
import { serializeConfig, type ConfigFormat } from '../src/config-format.js';
import { showConfig, setWorkspaceEnabled, rebindWorkspace } from '../src/config-admin.js';
import { migrateConfiguration } from '../src/config-migration.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const secret = 'synthetic-v010-private-key';
const privateArgument = 'synthetic-fixed-argument';
async function fixture(t: TestContext, format: ConfigFormat = 'json') {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-v010-config-'));
  const root = path.join(base, '项目'), second = path.join(base, '论文');
  await Promise.all([mkdir(root), mkdir(second)]);
  const configPath = path.join(base, 'config.' + format);
  const raw: any = defaultUnifiedConfig(root, configPath);
  raw.tunnel.apiKey = secret;
  raw.execution.profiles = { research: { allowedExecutables: { node: { command: '${nodePath}', args: [privateArgument] } }, env: { NODE_ENV:'test' } } };
  raw.workspaces.push({root:second,id:'papers',executionProfile:'research'});
  const write = async () => { const bytes = serializeConfig(raw, format); await writeFile(configPath, bytes); return bytes; };
  await write();
  t.after(async () => { assert.equal(path.dirname(await realpath(base)), parent); assert.ok(path.basename(base).startsWith('webcodex-v010-config-')); await rm(base,{recursive:true,force:true}); });
  const command = async (...args: string[]) => {
    const result = await run(process.execPath, [cli,...args,'--config',configPath], {windowsHide:true});
    assert.ok(!(result.stdout+result.stderr).includes(secret)); assert.ok(!result.stdout.includes(privateArgument));
    return JSON.parse(result.stdout) as any;
  };
  return {base,root,second,configPath,raw,write,command};
}

for (const format of ['json','toml'] as const) {
  test(`${format} v0.10 profiles and unavailable workspace settings normalize without state or config writes`,async t => {
    const f = await fixture(t,format);
    f.raw.workspaces[1].onUnavailable = 'skip';
    await rmdir(f.second);
    f.raw.workspaces.push({root:path.join(f.base,'disabled missing'),enabled:false});
    const original = await f.write();
    const config = await loadConfig(f.configPath);
    assert.equal(config.execution.profiles!.research.allowedExecutables.node instanceof Object,true);
    assert.deepEqual(config.execution.profiles!.research.allowedExecutables.node,{command:process.execPath,args:[privateArgument]});
    const shown = await showConfig(f.configPath);
    assert.equal(shown.workspaces[1].status,'missing'); assert.equal(shown.workspaces[2].status,'disabled');
    assert.equal(shown.workspaces[1].execution.profile,'research');
    assert.deepEqual(shown.workspaces[1].execution.configured_environment_names,['NODE_ENV']);
    assert.ok(!JSON.stringify(shown).includes(privateArgument)); assert.ok(!JSON.stringify(shown).includes(secret));
    assert.equal(await readFile(f.configPath,'utf8'),original);
    await assert.rejects(lstat(config.stateDir),{code:'ENOENT'});
    await assert.rejects(lstat(f.second),{code:'ENOENT'});
  });

  test(`${format} CLI diagnoses a strict missing root and disables/enables it while preserving identity and credentials`,async t => {
    const f = await fixture(t,format);
    const prior = await loadConfig(f.configPath);
    await rmdir(f.second);
    const original = await readFile(f.configPath,'utf8');
    await assert.rejects(loadConfig(f.configPath),{code:'CONFIG_ERROR'});
    const health = await f.command('workspace','health');
    assert.equal(health.workspaces[0].status,'available'); assert.equal(health.workspaces[1].status,'missing');
    assert.equal(await readFile(f.configPath,'utf8'),original);
    await f.command('workspace','disable','--id','papers');
    const disabled = await loadConfig(f.configPath);
    assert.equal(disabled.workspaces[1].enabled,false); assert.equal(disabled.workspaces[1].uid,prior.workspaces[1].uid);
    assert.equal(disabled.workspaces[1].executionProfile,'research'); assert.equal(disabled.tunnel!.apiKey,secret);
    const disabledBytes = await readFile(f.configPath,'utf8');
    await assert.rejects(f.command('workspace','enable','--id','papers'));
    assert.equal(await readFile(f.configPath,'utf8'),disabledBytes);
    await mkdir(f.second);
    await f.command('workspace','enable','--id','papers');
    assert.equal((await loadConfig(f.configPath)).workspaces[1].uid,prior.workspaces[1].uid);
    await f.command('workspace','rebind','--id','papers','--root',f.second,'--new-identity');
    const rebound = await loadConfig(f.configPath);
    assert.equal(rebound.workspaces[1].id,'papers'); assert.notEqual(rebound.workspaces[1].uid,prior.workspaces[1].uid);
    assert.equal(rebound.workspaces[1].executionProfile,'research'); assert.equal(rebound.tunnel!.apiKey,secret);
    await assert.rejects(lstat(rebound.stateDir),{code:'ENOENT'});
  });

  test(`${format} migration preserves profile settings and disabled or missing workspace identities`,async t => {
    const f = await fixture(t,format);
    f.raw.workspaces[1].onUnavailable='skip'; await rmdir(f.second);
    f.raw.workspaces.push({root:path.join(f.base,'disabled missing'),enabled:false}); await f.write();
    const before = await loadConfig(f.configPath);
    const output = path.join(f.base,format === 'json' ? 'migrated.toml':'migrated.json');
    await migrateConfiguration({source:f.configPath,output,apply:true});
    const after = await loadConfig(output);
    assert.deepEqual(after.workspaces,before.workspaces); assert.deepEqual(after.execution,before.execution);
    assert.equal(after.tunnel!.apiKey,secret); await assert.rejects(lstat(f.second),{code:'ENOENT'});
  });
}

test('v0.10 schema rejects undefined/invalid profiles, environment injection and unavailable-policy typos',async t => {
  const f = await fixture(t);
  for (const mutate of [
    (raw:any) => {raw.workspaces[1].executionProfile='unknown';},
    (raw:any) => {raw.workspaces[1].enabled='false';},
    (raw:any) => {raw.workspaces[1].onUnavailable='ignore';},
    (raw:any) => {raw.execution.profiles.research.env={NODE_OPTIONS:'--require bad'};},
    (raw:any) => {raw.execution.profiles.research.allowedExecutables.node='script.cmd';},
    (raw:any) => {raw.execution.profiles['bad:name']=raw.execution.profiles.research;},
    (raw:any) => {raw.execution.profiles=Object.fromEntries(Array.from({length:33},(_,i)=>['p'+i,{allowedExecutables:{}}]));},
  ]) {
    const bad=structuredClone(f.raw); mutate(bad);
    await assert.rejects(validateConfig(bad,f.configPath),error=>{assert.equal((error as any).code,'CONFIG_ERROR');assert.ok(!String(error).includes(secret));return true;});
  }
  const empty = structuredClone(f.raw); empty.execution.profiles.research.allowedExecutables={};
  assert.deepEqual((await validateConfig(empty,f.configPath)).execution.profiles!.research.allowedExecutables,{});
});

test('doctor and execution inspect report per-workspace readiness without treating skipped roots as existing',async t => {
  const f = await fixture(t);
  f.raw.workspaces[1].onUnavailable='skip'; await rmdir(f.second);
  // Isolated probe stubs: node --version exercises doctor output, not a claim that Node is Git/ripgrep.
  f.raw.gitPath=process.execPath; f.raw.rgPath=process.execPath; await f.write();
  const doctor=await f.command('doctor');
  assert.equal(doctor.ok,true); assert.equal(doctor.workspaces[1].exists,false); assert.equal(doctor.workspaces[1].writable,false);
  const execution=await f.command('execution','inspect');
  assert.equal(execution.workspaces[1].profile,'research'); assert.equal(execution.workspaces[1].ready,false);
  assert.equal(execution.workspaces[1].status,'missing');
});

test('disabled directory aliases remain addressable by their lexical ID and cannot be enabled through a link',async t => {
  const f=await fixture(t);
  const linked=path.join(f.base,'disabled alias'),replacement=path.join(f.base,'replacement');
  await symlink(f.second,linked,process.platform==='win32'?'junction':'dir');await mkdir(replacement);
  f.raw.workspaces.push({root:linked,enabled:false});await f.write();
  const prior=await loadConfig(f.configPath), selected=prior.workspaces[2];
  const bytes=await readFile(f.configPath,'utf8');
  await assert.rejects(setWorkspaceEnabled(f.configPath,selected.id,true),{code:'CONFIG_ERROR'});
  assert.equal(await readFile(f.configPath,'utf8'),bytes);
  await rebindWorkspace(f.configPath,{id:selected.id,root:replacement});
  const after=await loadConfig(f.configPath);
  assert.equal(after.workspaces[2].id,selected.id);assert.equal(after.workspaces[2].root,replacement);
  assert.notEqual(after.workspaces[2].uid,selected.uid);assert.equal(after.workspaces[2].enabled,false);
});
