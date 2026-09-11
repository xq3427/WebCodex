import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink, link, unlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultUnifiedConfig, loadConfig, validateConfig } from '../src/config.js';
import { parseConfigText, serializeConfig, type ConfigFormat } from '../src/config-format.js';
import { PanelConfigService } from '../src/panel-config.js';
import { PANEL_SAFE_ISSUE_MESSAGES, isPanelField, safePanelDetails } from '../src/panel-validation.js';

async function fixture(t: TestContext, format: ConfigFormat = 'json') {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'webcodex-panel-config-')));
  const root = path.join(directory, 'project'), second = path.join(directory, 'second');
  await Promise.all([mkdir(root), mkdir(second)]);
  const configPath = path.join(directory, 'config.' + format);
  const raw = defaultUnifiedConfig(root, configPath);
  raw.tunnel.apiKey = 'private-panel-test-api-key';
  raw.http.bearerToken = 'private-panel-test-http-token'.padEnd(40, 'x');
  raw.execution.allowedExecutables.node = { command:'${nodePath}', args:['private-fixed-argument'] };
  const rawObject = raw as unknown as Record<string,unknown>;
  (rawObject.execution as Record<string,unknown>).env = { LANG:'private-environment-value' };
  await writeFile(configPath, (format === 'toml' ? '# Preserve this owner comment\n' : '') + serializeConfig(raw, format));
  t.after(async () => { const resolved = path.resolve(directory); assert.ok(path.isAbsolute(resolved) && path.basename(resolved).startsWith('webcodex-panel-config-') && path.dirname(resolved) !== resolved); await rm(resolved,{recursive:true,force:true}); });
  const service = new PanelConfigService(configPath);
  const content = async () => parseConfigText(await readFile(configPath,'utf8'), format) as typeof raw;
  return { directory, root, second, configPath, raw, rawObject, service, content, format };
}

test('panel snapshot redacts all secrets and fixed arguments while preserving raw portable paths', async t => {
  const f = await fixture(t);
  const snapshot = await f.service.read();
  assert.match(snapshot.revision,/^[a-f0-9]{64}$/);
  assert.equal(snapshot.format,'json');
  assert.deepEqual(snapshot.secrets,{tunnelApiKey:true,httpBearerToken:true});
  assert.equal((snapshot.values.workspaces as Array<{root:string}>)[0].root, f.raw.workspaces[0].root);
  assert.equal(snapshot.values.nodePath,'auto');
  const rendered = JSON.stringify(snapshot);
  for (const secret of [f.raw.tunnel.apiKey,f.raw.http.bearerToken,'private-fixed-argument','private-environment-value']) assert.equal(rendered.includes(secret),false);
  assert.deepEqual(snapshot.read_only.environment_names,['LANG']);
  assert.deepEqual((snapshot.values.execution as {executables:unknown[]}).executables,[{alias:'node',command:'${nodePath}',prefix_arg_count:1}]);
  assert.equal((await readdir(f.directory)).some(name=>name==='state'),false);
});

for (const format of ['json','toml'] as const) test(`panel saves ${format} atomically with CAS, secret retention and comments`, async t => {
  const f = await fixture(t,format);
  const before = await f.service.read();
  const result = await f.service.save({expected_revision:before.revision,patch:{device:{name:'我的设备'},diagnostics:{enabled:false}}});
  assert.equal(result.restart_required,true);
  assert.equal(result.changed_again,false);
  assert.equal(result.saved_revision,result.revision);
  assert.notEqual(result.revision,before.revision);
  const saved = await f.content();
  assert.equal(saved.device.name,'我的设备');
  assert.equal(saved.diagnostics.enabled,false);
  assert.equal(saved.tunnel.apiKey,f.raw.tunnel.apiKey);
  assert.equal(saved.http.bearerToken,f.raw.http.bearerToken);
  assert.deepEqual(saved.execution.allowedExecutables,f.raw.execution.allowedExecutables);
  assert.deepEqual((saved.execution as unknown as Record<string,unknown>).env,{LANG:'private-environment-value'});
  if (format==='toml') assert.match(await readFile(f.configPath,'utf8'),/# Preserve this owner comment/);
  await assert.rejects(f.service.save({expected_revision:before.revision,patch:{device:{name:'stale'}}}),{code:'CONFIG_CONFLICT'});
  assert.equal((await f.content()).device.name,'我的设备');
  assert.equal((await readdir(f.directory)).some(name=>name.endsWith('.lock')||name.startsWith('.webcodex-write-config-')),false);
});

for (const format of ['json','toml'] as const) test(`panel saves larger chunk budgets in ${format} and pinpoints out-of-range fields`, async t => {
  const f=await fixture(t,format), before=await f.service.read();
  assert.equal((before.values.binaryInputs as {chunkMaxBytes:number}).chunkMaxBytes,65536);
  assert.equal((before.values.binaryInputs as {maxCacheBytes:number}).maxCacheBytes,67108864);
  const request={expected_revision:before.revision,patch:{binaryInputs:{chunkMaxBytes:262144,maxCacheBytes:536870912}}};
  await f.service.validate(request);
  const saved=await f.service.save(request);
  assert.equal(saved.readback_verified,true);
  assert.equal((saved.values.binaryInputs as {chunkMaxBytes:number}).chunkMaxBytes,262144);
  assert.equal((saved.values.binaryInputs as {maxCacheBytes:number}).maxCacheBytes,536870912);
  const content=await f.content();assert.equal(content.tunnel.apiKey,f.raw.tunnel.apiKey);assert.deepEqual(content.execution,f.raw.execution);
  for(const [field,value] of [['chunkMaxBytes',262145],['maxCacheBytes',536870913]] as const) {
    await assert.rejects(f.service.save({expected_revision:saved.revision,patch:{binaryInputs:{[field]:value}}}),(error:any)=>{
      assert.equal(error.code,'PANEL_CONFIG_INVALID');
      assert.ok(JSON.stringify(error.details).includes(`binaryInputs.${field}`));
      return true;
    });
    assert.equal((await f.service.read()).revision,saved.revision);
  }
});

test('secret replacement and clearing are explicit; validation never writes values or leaks them', async t => {
  const f = await fixture(t);
  const before = await f.service.read();
  const bytes = await readFile(f.configPath);
  const request = {expected_revision:before.revision,patch:{},secrets:{tunnelApiKey:'replacement-private-key',httpBearerToken:null}};
  assert.equal((await f.service.validate(request)).valid,true);
  assert.deepEqual(await readFile(f.configPath),bytes);
  const result = await f.service.save(request);
  assert.deepEqual(result.secrets,{tunnelApiKey:true,httpBearerToken:false});
  assert.equal(JSON.stringify(result).includes('replacement-private-key'),false);
  assert.equal((await f.content()).tunnel.apiKey,'replacement-private-key');
  assert.equal((await f.content()).http.bearerToken,'');
  await assert.rejects(f.service.save({expected_revision:result.revision,patch:{},secrets:{tunnelApiKey:'secret with whitespace'}}),error=>{
    assert.equal((error as {code:string}).code,'PANEL_CONFIG_INVALID');
    assert.equal(JSON.stringify(error).includes('secret with whitespace'),false); return true;
  });
});

test('panel rejects uneditable scopes, prototype keys and secret fields submitted through patch', async t => {
  const f = await fixture(t);
  const snapshot = await f.service.read(), before = await readFile(f.configPath);
  const patches = [{stateDir:f.second},{device:{id:f.raw.device.id}},{execution:{env:{X:'private-new-env'}}},{execution:{allowedExecutables:{bad:process.execPath}}},{tunnel:{apiKey:'private-misplaced-key'}},{http:{bearerToken:'private-misplaced-key'}},{workspaces:[{id:'default',root:f.root,uid:f.raw.workspaces[0].uid}]},JSON.parse('{"constructor":{"danger":"private-prototype"}}')];
  for (const patch of patches) await assert.rejects(f.service.save({expected_revision:snapshot.revision,patch}),error=>{
    assert.equal((error as {code:string}).code,'PANEL_CONFIG_INVALID');
    assert.equal(JSON.stringify(error).includes('private-'),false); return true;
  });
  assert.deepEqual(await readFile(f.configPath),before);
});

test('workspace edits retain identity, assign a new identity for moved roots and never delete directory contents', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root,'keep.txt'),'keep original files');
  const snapshot = await f.service.read();
  const initialUid = f.raw.workspaces[0].uid;
  const renamed = await f.service.save({expected_revision:snapshot.revision,patch:{workspaces:[{id:'default',root:f.raw.workspaces[0].root,name:'改名',readOnly:true}]}});
  assert.equal((await f.content()).workspaces[0].uid,initialUid);
  assert.equal((await f.content()).workspaces[0].readOnly,true);
  const moved = await f.service.save({expected_revision:renamed.revision,patch:{workspaces:[{id:'default',root:f.second,name:'第二目录',readOnly:false}]}});
  assert.notEqual((await f.content()).workspaces[0].uid,initialUid);
  assert.equal(await readFile(path.join(f.root,'keep.txt'),'utf8'),'keep original files');
  const added = await f.service.save({expected_revision:moved.revision,patch:{workspaces:[{id:'default',root:f.second},{id:'original',root:f.root,name:'原目录',readOnly:true}]}});
  const current = await loadConfig(f.configPath);
  assert.equal(current.workspaces.length,2);
  assert.match(current.workspaces[1].uid!,/^[a-f0-9-]{36}$/);
  await f.service.save({expected_revision:added.revision,patch:{workspaces:[{id:'default',root:f.second}]}});
  assert.equal(await readFile(path.join(f.root,'keep.txt'),'utf8'),'keep original files');
});

test('shorthand workspaces materialize stable identity and offline roots can be disabled or rebound', async t => {
  const f = await fixture(t);
  f.rawObject.workspaces = [f.root];
  await writeFile(f.configPath,serializeConfig(f.rawObject,f.format));
  const initial = await validateConfig(f.rawObject,f.configPath), snapshot = await f.service.read();
  const workspaceId = initial.workspaces[0].id;
  await f.service.save({expected_revision:snapshot.revision,patch:{workspaces:[{id:workspaceId,root:f.root,name:'保留标识'}]}});
  assert.equal((await loadConfig(f.configPath)).workspaces[0].uid,initial.workspaces[0].uid);
  const raw = await f.content();
  raw.workspaces[0].root = path.join(f.directory,'offline');
  await writeFile(f.configPath,serializeConfig(raw,f.format));
  const offline = await f.service.read();
  await f.service.save({expected_revision:offline.revision,patch:{workspaces:[{id:workspaceId,root:raw.workspaces[0].root,enabled:false}]}});
  assert.equal((await loadConfig(f.configPath)).workspaces[0].enabled,false);
  const disabled = await f.service.read();
  await f.service.save({expected_revision:disabled.revision,patch:{workspaces:[{id:workspaceId,root:f.second,enabled:true}]}});
  assert.equal((await loadConfig(f.configPath)).workspaces[0].root,f.second);
});

test('panel repairs a missing Codex home without activating reads or accepting unrelated invalid state', async t => {
  const f = await fixture(t);
  f.raw.codexSessions.enabled = true;
  f.raw.codexSessions.home = path.join(f.directory,'missing-codex');
  await writeFile(f.configPath,serializeConfig(f.raw,f.format));
  const snapshot = await f.service.read();
  assert.equal((snapshot.values.codexSessions as {enabled:boolean}).enabled,true);
  await assert.rejects(f.service.save({expected_revision:snapshot.revision,patch:{device:{name:'not repaired'}}}),{code:'CONFIG_PATH_DENIED'});
  await f.service.save({expected_revision:snapshot.revision,patch:{codexSessions:{enabled:false}}});
  assert.equal((await loadConfig(f.configPath)).codexSessions.enabled,false);
});

test('workspace authorization rejects linked and protected roots; selected config rejects hard links', async t => {
  const f = await fixture(t), snapshot = await f.service.read();
  const linked = path.join(f.directory,'linked'), protectedRoot = path.join(f.directory,'.ssh');
  await mkdir(protectedRoot);
  await symlink(f.second,linked,process.platform==='win32'?'junction':'dir');
  for (const root of [linked,protectedRoot]) await assert.rejects(f.service.save({expected_revision:snapshot.revision,patch:{workspaces:[{id:'default',root}]}}));
  const alias = path.join(f.directory,'hard.json');
  await link(f.configPath,alias);
  await assert.rejects(f.service.read(),{code:'CONFIG_PATH_DENIED'});
  await assert.rejects(f.service.save({expected_revision:snapshot.revision,patch:{device:{name:'blocked'}}}),{code:'CONFIG_PATH_DENIED'});
  await unlink(alias);
  assert.equal((await f.content()).device.name,f.raw.device.name);
});

test('executable editing preserves hidden prefix args and refuses accidental command replacement', async t => {
  const f = await fixture(t), snapshot = await f.service.read();
  await assert.rejects(f.service.save({expected_revision:snapshot.revision,patch:{execution:{executables:[{alias:'node',command:path.join(f.directory,'new-runtime')}]}}}),{code:'PANEL_EXECUTABLE_ARGS_PROTECTED'});
  const saved = await f.service.save({expected_revision:snapshot.revision,patch:{execution:{executables:[{alias:'node',command:'${nodePath}',prefix_arg_count:1},{alias:'test',command:process.execPath}]}}});
  assert.deepEqual((await f.content()).execution.allowedExecutables.node,{command:'${nodePath}',args:['private-fixed-argument']});
  assert.equal(JSON.stringify(saved).includes('private-fixed-argument'),false);
  assert.deepEqual(((await f.content()).execution.allowedExecutables as Record<string,unknown>).test,{command:process.execPath,args:[]});
});

test('proxy origins are editable while unsafe legacy URLs are hidden and require explicit repair', async t => {
  const f = await fixture(t), snapshot = await f.service.read();
  const saved = await f.service.save({expected_revision:snapshot.revision,patch:{tunnel:{proxyUrl:'http://127.0.0.1:8888'}}});
  assert.equal((saved.values.tunnel as {proxyUrl:string}).proxyUrl,'http://127.0.0.1:8888');
  const raw = await f.content();
  raw.tunnel.proxyUrl = 'http://private-user:private-password@example.test/?private-query';
  await writeFile(f.configPath,serializeConfig(raw,f.format));
  const invalid = await f.service.read();
  assert.equal((invalid.values.tunnel as {proxyUrl:string}).proxyUrl,'');
  assert.equal(invalid.issues[0].code,'PANEL_PROXY_INVALID');
  assert.equal(JSON.stringify(invalid).includes('private-password'),false);
  await assert.rejects(f.service.save({expected_revision:invalid.revision,patch:{device:{name:'other'}}}),{code:'CONFIG_ERROR'});
  assert.equal((await f.content()).tunnel.proxyUrl,raw.tunnel.proxyUrl);
  await f.service.save({expected_revision:invalid.revision,patch:{tunnel:{proxyUrl:''}}});
  assert.equal((await f.content()).tunnel.proxyUrl,'');
});

test('validation enforces cross-field execution and HTTP auth requirements without touching disk', async t => {
  const f = await fixture(t), snapshot = await f.service.read(), before = await readFile(f.configPath);
  await assert.rejects(f.service.validate({expected_revision:snapshot.revision,patch:{execution:{defaultTimeoutMs:60000,maxTimeoutMs:1000}}}),{code:'CONFIG_ERROR'});
  await assert.rejects(f.service.validate({expected_revision:snapshot.revision,patch:{server:{transport:'http'}},secrets:{httpBearerToken:null}}),{code:'CONFIG_ERROR'});
  await assert.rejects(f.service.validate({expected_revision:'0'.repeat(64),patch:{}}),{code:'CONFIG_CONFLICT'});
  assert.deepEqual(await readFile(f.configPath),before);
});

test('a committed save retains its safe receipt when a subsequent read fails or another editor intervenes', async t => {
  const f = await fixture(t), snapshot = await f.service.read();
  const originalRead = f.service.read.bind(f.service);
  f.service.read = async () => { throw new Error('private-readback-detail'); };
  const saved = await f.service.save({expected_revision:snapshot.revision,patch:{device:{name:'committed'}}});
  assert.equal(saved.ok,true);
  assert.equal(saved.revision,saved.saved_revision);
  assert.equal(saved.changed_again,true);
  assert.equal(saved.readback_verified,false);
  assert.equal(saved.readback_error,'CONFIG_ERROR');
  assert.equal(JSON.stringify(saved).includes('private-readback-detail'),false);
  assert.equal((await f.content()).device.name,'committed');
  f.service.read = async () => {
    const raw = await f.content(); raw.device.name='external-editor';
    await writeFile(f.configPath,serializeConfig(raw,f.format));
    return originalRead();
  };
  const next = await f.service.save({expected_revision:saved.revision,patch:{device:{name:'second-commit'}}});
  assert.equal(next.revision,next.saved_revision);
  assert.equal((next.values.device as {name:string}).name,'second-commit');
  assert.equal(next.changed_again,true);
  assert.notEqual(next.current_revision,next.saved_revision);
  assert.equal((await f.content()).device.name,'external-editor');
});

test('validation identifies exact inputs and actual supported numeric ranges without exposing submitted values', async t => {
  const f=await fixture(t), snapshot=await f.service.read(), before=await readFile(f.configPath);
  const cases:Array<{patch:unknown;secrets?:unknown;field:string;phrase:string}>= [
    {patch:{localPanel:{port:80}},field:'localPanel.port',phrase:'1024–65535'},
    {patch:{execution:{maxConcurrent:9}},field:'execution.maxConcurrent',phrase:'1–8'},
    {patch:{limits:{fileWidgetUploadMaxBytes:536870913}},field:'limits.fileWidgetUploadMaxBytes',phrase:'1–536870912'},
    {patch:{tunnel:{clientSha256:'private-invalid-hash'}},field:'tunnel.clientSha256',phrase:'64'},
    {patch:{tunnel:{clientVersion:'private-invalid-version'}},field:'tunnel.clientVersion',phrase:'v1.2.3'},
    {patch:{tunnel:{proxyUrl:'https://private-user:private-password@example.invalid'}},field:'tunnel.proxyUrl',phrase:'代理'},
    {patch:{},secrets:{tunnelApiKey:'private bad key'},field:'secrets.tunnelApiKey',phrase:'空格'},
    {patch:{workspaces:[{id:'default',root:f.root,name:''}]},field:'workspaces.0.name',phrase:'1–120'},
    {patch:{workspaces:[{id:'private invalid id',root:f.root}]},field:'workspaces.0.id',phrase:'1–64'},
  ];
  for(const item of cases)await assert.rejects(f.service.validate({expected_revision:snapshot.revision,patch:item.patch,...(item.secrets?{secrets:item.secrets}:{})}),error=>{
    const details=(error as {details:{fields:string[];issues:Array<{field:string;message:string}>}}).details;
    assert.ok(details.fields.includes(item.field));
    assert.ok(details.issues.find(issue=>issue.field===item.field)?.message.includes(item.phrase));
    assert.ok(details.issues.every(issue=>isPanelField(issue.field)&&PANEL_SAFE_ISSUE_MESSAGES.includes(issue.message)));
    assert.equal(JSON.stringify(error).includes('private-'),false);assert.equal(JSON.stringify(error).includes('private bad key'),false);
    return true;
  });
  assert.deepEqual(await readFile(f.configPath),before);
});

test('cross-field connection and command errors report each corrective field and retain the selected file',async t=>{
  const f=await fixture(t), snapshot=await f.service.read(), before=await readFile(f.configPath);
  const cases:Array<{patch:unknown;secrets?:unknown;fields:string[]}>= [
    {patch:{execution:{defaultTimeoutMs:60000,maxTimeoutMs:1000}},fields:['execution.defaultTimeoutMs','execution.maxTimeoutMs']},
    {patch:{execution:{defaultWaitMs:100,maxWaitMs:1,stdinMaxBytes:100,stdinMaxTotalBytes:1}},fields:['execution.defaultWaitMs','execution.maxWaitMs','execution.stdinMaxBytes','execution.stdinMaxTotalBytes']},
    {patch:{projectContext:{maxFileBytes:2048,maxTotalBytes:1024}},fields:['projectContext.maxFileBytes','projectContext.maxTotalBytes']},
    {patch:{tunnel:{enabled:true}},secrets:{tunnelApiKey:null},fields:['tunnel.id','secrets.tunnelApiKey']},
    {patch:{tunnel:{clientPath:process.execPath}},fields:['tunnel.clientSha256']},
    {patch:{server:{transport:'http'}},secrets:{httpBearerToken:'short-private'},fields:['secrets.httpBearerToken']},
    {patch:{codexSessions:{enabled:true,home:null}},fields:['codexSessions.home']},
  ];
  for(const item of cases)await assert.rejects(f.service.save({expected_revision:snapshot.revision,patch:item.patch,...(item.secrets?{secrets:item.secrets}:{})}),error=>{
    assert.deepEqual((error as {details:{fields:string[]}}).details.fields,item.fields);
    assert.equal(JSON.stringify(error).includes('short-private'),false);return true;
  });
  assert.deepEqual(await readFile(f.configPath),before);
});

test('workspace diagnostics target the affected row for missing paths, duplicate IDs and permissions conflicts',async t=>{
  const f=await fixture(t), snapshot=await f.service.read();
  const nested=path.join(f.root,'nested');await mkdir(nested);
  const rows:Array<{entries:unknown[];fields:string[]}>= [
    {entries:[{id:'default',root:f.root},{id:'second',root:path.join(f.directory,'private-missing-root')}],fields:['workspaces.1.root']},
    {entries:[{id:'default',root:f.root},{id:'default',root:f.second}],fields:['workspaces.1.id']},
    {entries:[{id:'default',root:f.root},{id:'second',root:f.root}],fields:['workspaces.1.root']},
    {entries:[{id:'default',root:f.root,readOnly:false},{id:'second',root:nested,readOnly:true}],fields:['workspaces.1.readOnly','workspaces.0.readOnly']},
  ];
  for(const row of rows)await assert.rejects(f.service.validate({expected_revision:snapshot.revision,patch:{workspaces:row.entries}}),error=>{
    assert.deepEqual((error as {details:{fields:string[]}}).details.fields,row.fields);
    assert.equal(JSON.stringify(error).includes('private-missing-root'),false);return true;
  });
  const current=await f.content();current.workspaces[0].root=path.join(f.directory,'private-offline-existing');
  await writeFile(f.configPath,serializeConfig(current,f.format));const offline=await f.service.read();
  await assert.rejects(f.service.validate({expected_revision:offline.revision,patch:{device:{name:'other'}}}),error=>{
    assert.deepEqual((error as {details:{fields:string[]}}).details.fields,['workspaces.0.root']);return true;
  });
});

test('single execution switch persists only an explicit command policy and preserves legacy aliases and hidden settings',async t=>{
  const f=await fixture(t), initial=await f.service.read();
  assert.equal((initial.values.execution as {commandPolicy:string}).commandPolicy,'allowlist');
  const unrelated=await f.service.save({expected_revision:initial.revision,patch:{device:{name:'rename'}}});
  assert.equal(Object.hasOwn((await f.content()).execution,'commandPolicy'),false);
  const enabled=await f.service.save({expected_revision:unrelated.revision,patch:{execution:{mode:'trusted-host',commandPolicy:'all'}}});
  assert.equal((enabled.values.execution as {commandPolicy:string}).commandPolicy,'all');
  const disabled=await f.service.save({expected_revision:enabled.revision,patch:{execution:{mode:'disabled'}}});
  assert.equal((disabled.values.execution as {commandPolicy:string}).commandPolicy,'all');
  const saved=await f.content();
  assert.deepEqual(saved.execution.allowedExecutables,f.raw.execution.allowedExecutables);
  assert.deepEqual((saved.execution as unknown as {env:unknown}).env,{LANG:'private-environment-value'});
});

test('diagnostic sanitization cannot return arbitrary property paths, unbounded indices or raw exception messages',()=>{
  assert.equal(safePanelDetails({fields:['workspaces.999999.root','tunnel.private-key','__proto__'],issues:[{field:'tunnel.clientSha256',message:'private-secret-error'}]}),undefined);
  assert.deepEqual(safePanelDetails({issues:[{field:'workspaces.1.root',message:PANEL_SAFE_ISSUE_MESSAGES[0],extra:'private-leak'}]}),{
    issues:[{field:'workspaces.1.root',message:PANEL_SAFE_ISSUE_MESSAGES[0]}],fields:['workspaces.1.root'],
  });
});
