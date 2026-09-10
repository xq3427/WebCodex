import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig, defaultUnifiedConfig, loadConfig, validateConfig } from '../src/config.js';
import { disableActionsProbe, publicConfig } from '../src/config-admin.js';
import { migrateConfiguration } from '../src/config-migration.js';
import { parseConfigText, serializeConfig, type ConfigFormat } from '../src/config-format.js';

const legacyKey='synthetic-archived-actions-key-never-print-519403';
const legacyOrigin='https://synthetic-private-origin.invalid';
const legacy={enabled:true,apiKey:legacyKey,publicBaseUrl:legacyOrigin,port:8766,quickTunnel:{clientPath:'./missing-client/cloudflared',startupTimeoutMs:60000,proxyUrl:'http://127.0.0.1:17890'}};

async function fixture(t:TestContext,format:ConfigFormat='json') {
  const parent=await realpath(tmpdir());
  const base=await mkdtemp(path.join(parent,'webcodex-panel-config-'));
  const root=path.join(base,'中文项目 with spaces');await mkdir(root);
  const configPath=path.join(base,'config.'+format);
  const raw=defaultUnifiedConfig(root,configPath);
  raw.stateDir=path.join(base,'unused-state');raw.toolsDir=path.join(base,'unused-tools');
  t.after(async()=>{const actual=await realpath(base);assert.equal(path.dirname(actual),parent);assert.ok(path.basename(actual).startsWith('webcodex-panel-config-'));await rm(actual,{recursive:true,force:true});});
  return {base,root,configPath,raw,write:async(value:unknown)=>writeFile(configPath,serializeConfig(value,format)),
    unchanged:async()=>{await assert.rejects(access(raw.stateDir),{code:'ENOENT'});await assert.rejects(access(raw.toolsDir),{code:'ENOENT'});}};
}
function safeFailure(error:unknown) {
  assert.equal((error as {code:string}).code,'CONFIG_ERROR');
  assert.ok(!String(error).includes(legacyKey));return true;
}

for(const format of ['json','toml'] as const){
  test(`${format} local panel defaults do not generate experiments or create state`,async t=>{
    const f=await fixture(t,format);
    assert.deepEqual(f.raw.localPanel,{port:8767});assert.equal('actionsProbe' in f.raw,false);assert.equal('nativeAttachment' in f.raw,false);
    const old:Record<string,unknown>={...f.raw};delete old.localPanel;
    for(const raw of [old,{...old,localPanel:{}},f.raw]){
      await f.write(raw);const before=await readFile(f.configPath);
      const loaded=await loadConfig(f.configPath);
      assert.deepEqual(loaded.localPanel,{port:8767});assert.equal(loaded.actionsProbe,undefined);
      assert.deepEqual(publicConfig(loaded).localPanel,{port:8767});assert.equal(publicConfig(loaded).actionsProbe,undefined);
      assert.deepEqual(await readFile(f.configPath),before);await f.unchanged();
    }
    const v1=defaultConfig(f.root,f.configPath);
    assert.equal((await validateConfig(v1,f.configPath)).localPanel,undefined);
    await assert.rejects(validateConfig({...v1,localPanel:{port:8767}},f.configPath),safeFailure);
  });

  test(`${format} panel port range and strict configuration reject unsupported server settings`,async t=>{
    const f=await fixture(t,format);
    for(const port of [1024,8767,65535]){
      await f.write({...f.raw,localPanel:{port}});
      assert.deepEqual((await loadConfig(f.configPath)).localPanel,{port});
    }
    for(const localPanel of [null,[],8767,{port:null},{port:0},{port:1023},{port:65536},{port:8767.5},{port:'8767'},{host:'0.0.0.0'},{apiKey:legacyKey},{enabled:true}]){
      await assert.rejects(validateConfig({...f.raw,localPanel},f.configPath),safeFailure);
    }
    await f.unchanged();
  });

  test(`${format} archived Actions settings remain inert and private while disable changes only their flag`,async t=>{
    const f=await fixture(t,format);const raw={...f.raw,actionsProbe:legacy,localPanel:{port:8899}};
    await f.write(raw);const before=await readFile(f.configPath);
    const loaded=await loadConfig(f.configPath);
    assert.deepEqual(loaded.actionsProbe,legacy,'Inactive client paths and origins must not be resolved or used.');
    const shown=publicConfig(loaded);assert.equal(shown.actionsProbe?.active,false);assert.equal(shown.actionsProbe?.legacy,true);
    for(const value of [legacyKey,legacyOrigin,legacy.quickTunnel.clientPath,legacy.quickTunnel.proxyUrl])assert.ok(!JSON.stringify(shown).includes(value));
    assert.deepEqual(await readFile(f.configPath),before);await f.unchanged();
    const result=await disableActionsProbe(f.configPath);assert.equal(result.actionsProbe?.active,false);assert.ok(!JSON.stringify(result).includes(legacyKey));
    assert.deepEqual(parseConfigText(await readFile(f.configPath,'utf8'),format),parseConfigText(serializeConfig({...raw,actionsProbe:{...legacy,enabled:false}},format),format));
    await f.unchanged();
  });

  test(`${format} legacy browser settings do not advertise an active feature or create runtime directories`,async t=>{
    const f=await fixture(t,format);
    await f.write({...f.raw,nativeAttachment:{enabled:true}});
    const before=await readFile(f.configPath);
    const loaded=await loadConfig(f.configPath);
    const shown=publicConfig(loaded);
    assert.equal(shown.native_attachment?.active,false);
    assert.equal(shown.native_attachment?.legacy,true);
    for(const directory of [loaded.nativeAttachment!.runtimeDir,loaded.nativeAttachment!.browser.userDataDir]) {
      await assert.rejects(access(directory),{code:'ENOENT'});
      assert.ok(!JSON.stringify(shown).includes(directory));
    }
    assert.deepEqual(await readFile(f.configPath),before);await f.unchanged();
  });
}

test('migration preserves a custom local panel port and historical settings without activating or reporting their secrets',async t=>{
  const f=await fixture(t);await f.write({...f.raw,actionsProbe:legacy,localPanel:{port:8899}});
  const output=path.join(f.base,'migrated.toml');
  for(const apply of [false,true]){
    const result=await migrateConfiguration({source:f.configPath,output,apply});
    assert.equal(result.inactive_legacy_actions_probe,true);assert.ok(!JSON.stringify(result).includes(legacyKey));assert.ok(!JSON.stringify(result).includes(legacyOrigin));
    if(!apply)await f.unchanged();
  }
  const migrated=await loadConfig(output);assert.deepEqual(migrated.localPanel,{port:8899});assert.deepEqual(migrated.actionsProbe,legacy);
  // Applying a config migration intentionally writes its private config backup,
  // but must not initialize the database or the archived client's tools.
  assert.deepEqual(await readdir(f.raw.stateDir),['private-config-backups']);await assert.rejects(access(f.raw.toolsDir),{code:'ENOENT'});
});
