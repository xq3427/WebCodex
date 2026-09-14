import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { serializeConfig, parseConfigText } from '../src/config-format.js';
import { App } from '../src/app.js';
import { startHttp } from '../src/http.js';
import { VERSION } from '../src/version.js';
import { DatabaseSync } from 'node:sqlite';

const run=promisify(execFile);
const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
const secret='sk-synthetic-unified-config-never-output-123456';
async function fixture(t:TestContext,format:'json'|'toml'){
  const base=await mkdtemp(path.join(await realpath(tmpdir()),'webcodex-unified-integration-'));
  const root=path.join(base,'项目 with spaces');await mkdir(root);
  const configPath=path.join(root,'config.'+format);
  const raw=defaultUnifiedConfig(root,configPath,{deviceName:'测试笔记本'});
  raw.tunnel={...raw.tunnel,enabled:true,id:'tunnel_synthetic',apiKey:secret};
  raw.http.bearerToken='synthetic-http-token-'+randomUUID();
  raw.toolsDir='${configDir}/custom-tools';await mkdir(path.join(root,'custom-tools'));
  await writeFile(configPath,serializeConfig(raw,format));
  await writeFile(path.join(root,'hello.txt'),'before');
  await writeFile(path.join(root,'long.txt'),'中文😀'.repeat(120));
  t.after(async()=>{assert.ok(path.basename(base).startsWith('webcodex-unified-integration-'));await rm(base,{recursive:true,force:true});});
  return{base,root,configPath,raw,config:await loadConfig(configPath)};
}
async function exercise(client:Client,f:Awaited<ReturnType<typeof fixture>>){
  const tools=await client.listTools();assert.equal(tools.tools.length,66);
  for(const tool of tools.tools)if(!tool.annotations?.readOnlyHint)assert.ok(tool.inputSchema.required?.includes('expected_device_id'),tool.name);
  const call=(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args});
  const status:any=(await call('system_status')).structuredContent;
  assert.equal(status.source.device_id,f.raw.device.id);assert.equal(status.data.version,VERSION);
  assert.equal(status.source.device_name,'测试笔记本');assert.ok(status.source.instance_id);
  const input={workspace_id:'default',path:'new.txt',content:'created',expected_sha256:null,idempotency_key:'same-op'};
  const missing=await call('fs_write',input);assert.equal(missing.isError,true);
  const wrong:any=(await call('fs_write',{...input,expected_device_id:randomUUID()})).structuredContent;
  assert.equal(wrong.error.code,'DEVICE_MISMATCH');
  const right:any=(await call('fs_write',{...input,expected_device_id:f.raw.device.id})).structuredContent;
  assert.equal(right.ok,true);assert.equal(await readFile(path.join(f.root,'new.txt'),'utf8'),'created');
  const wrongRetry:any=(await call('fs_write',{...input,expected_device_id:randomUUID()})).structuredContent;
  assert.equal(wrongRetry.error.code,'DEVICE_MISMATCH');
  const duplicate:any=(await call('fs_write',{...input,expected_device_id:f.raw.device.id})).structuredContent;
  assert.equal(duplicate.data.change_id,right.data.change_id);
  for(const relative of [path.basename(f.configPath),'custom-tools','config.'+path.extname(f.configPath).slice(1)+'.lock']){
    const blocked:any=(await call('fs_read',{workspace_id:'default',path:relative})).structuredContent;
    assert.equal(blocked.error.code,'PATH_DENIED');
  }
  const source:any=(await call('workspace_list')).structuredContent;
  assert.equal(source.data.workspaces[0].workspace_uid,f.raw.workspaces[0].uid);
  let chunkCursor:string|undefined, chunkText='';
  do{
    const page:any=(await call('fs_read_chunk',{workspace_id:'default',path:'long.txt',max_bytes:257,...(chunkCursor?{cursor:chunkCursor}:{})})).structuredContent;
    assert.equal(page.ok,true);assert.equal(page.data.chunk.offset_bytes,Buffer.byteLength(chunkText));
    chunkText+=page.data.content;chunkCursor=page.data.next_cursor??undefined;
  }while(chunkCursor);
  assert.equal(chunkText,'中文😀'.repeat(120));
  const outputs=JSON.stringify([tools,status,right,wrong,source]);
  assert.equal(outputs.includes(secret),false);assert.equal(outputs.includes(f.raw.http.bearerToken),false);
}

test('v2 TOML stdio requires device ID before mutation and protects unified credentials',async t=>{
  const f=await fixture(t,'toml');const client=new Client({name:'v2-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[cli,'serve','--config',f.configPath],stderr:'pipe'});
  let diagnostics='';transport.stderr?.on('data',(chunk:Buffer)=>{diagnostics+=chunk.toString();});
  try{await client.connect(transport);await exercise(client,f);}finally{await client.close();}
  assert.equal(diagnostics.includes(secret),false);assert.equal(diagnostics.includes(f.raw.http.bearerToken),false);
});

test('v2 JSON HTTP uses configured token and same device checks; services do not retain secrets',async t=>{
  const f=await fixture(t,'json');const app=new App(f.config);
  assert.equal(app.ctx.config.tunnel?.apiKey,'');assert.equal(app.ctx.config.http.bearerToken,'');
  const listener=await startHttp(app,{token:f.config.http.bearerToken!,port:0});
  const client=new Client({name:'v2-http-test',version:'1'});
  try{
    assert.equal((await fetch(listener.url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
    await client.connect(new StreamableHTTPClientTransport(new URL(listener.url),{requestInit:{headers:{Authorization:'Bearer '+f.config.http.bearerToken}}}));
    await exercise(client,f);
  }finally{await client.close();await listener.close();await app.close();}
});

test('CLI public configuration/export/parser errors exclude values and export clears identities',async t=>{
  const f=await fixture(t,'toml');
  const shown=await run(process.execPath,[cli,'config','show','--config',f.configPath]);
  assert.equal(shown.stdout.includes(secret),false);assert.equal(shown.stdout.includes(f.raw.http.bearerToken),false);
  const output=path.join(f.base,'template.toml');
  await run(process.execPath,[cli,'config','export','--config',f.configPath,'--output',output]);
  const exported=await readFile(output,'utf8');const template:any=parseConfigText(exported,'toml');
  assert.equal(exported.includes(secret),false);assert.equal(exported.includes(f.raw.http.bearerToken),false);
  assert.equal(exported.includes(f.root),false);assert.notEqual(template.device.id,f.raw.device.id);
  assert.equal(template.device.id,'');assert.equal(template.workspaces[0].uid,'');
  assert.equal(template.tunnel.enabled,false);assert.equal(template.execution.mode,'disabled');
  await writeFile(f.configPath,'version=2\n["'+secret+'"]\nkey = "unfinished');
  await assert.rejects(run(process.execPath,[cli,'config','validate','--config',f.configPath]),(error:any)=>{
    assert.equal(error.stdout.includes(secret),false);assert.equal(error.stderr.includes(secret),false);return true;
  });
});

test('failed device identity startup releases database lease for original device',async t=>{
  const f=await fixture(t,'json');const first=new App(f.config);
  first.store.db.prepare("INSERT INTO operations(scope,op_key,digest,status,created_at) VALUES('pending-check','key','digest','pending','now')").run();
  await first.close();
  const different=structuredClone(f.config);different.device!.id=randomUUID();
  assert.throws(()=>new App(different),{code:'STATE_DEVICE_MISMATCH'});
  const db=new DatabaseSync(path.join(f.config.stateDir,'webcodex.sqlite'),{readOnly:true});
  try{assert.equal(db.prepare("SELECT status FROM operations WHERE scope='pending-check'").get()?.status,'pending');}finally{db.close();}
  const original=new App(f.config);await original.close();
});

test('init writes a private unified TOML with a local HTTP token and never overwrites it',async t=>{
  const f=await fixture(t,'json');const target=path.join(f.base,'new-device','config.toml');
  const result=await run(process.execPath,[cli,'init','--workspace',f.root,'--config',target]);
  const loaded=await loadConfig(target);assert.equal(loaded.version,2);assert.notEqual(loaded.device?.id,f.raw.device.id);
  assert.equal(loaded.execution.mode,'disabled');assert.equal(loaded.tunnel?.enabled,false);assert.equal(loaded.http.bearerToken?.length,64);
  assert.equal(result.stdout.includes(loaded.http.bearerToken!),false);
  const bytes=await readFile(target);
  await assert.rejects(run(process.execPath,[cli,'init','--workspace',f.root,'--config',target]));
  assert.deepEqual(await readFile(target),bytes);
});
