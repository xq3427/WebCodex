import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { App } from '../src/app.js';
import { startHttp } from '../src/http.js';
import { VERSION } from '../src/version.js';

const cli = fileURLToPath(new URL('../src/cli.js',import.meta.url));
const result = (value:any):any => {assert.equal(value.structuredContent?.ok,true,JSON.stringify(value));return value.structuredContent.data;};
const error = (value:any):string => {assert.equal(value.isError,true);return value.structuredContent.error.code;};
async function fixture(t:TestContext) {
  const parent=await realpath(tmpdir()),base=await mkdtemp(path.join(parent,'webcodex-v010-mcp-'));
  const appRoot=path.join(base,'代码项目'),paperRoot=path.join(base,'论文'),offlineRoot=path.join(base,'removable project');
  await Promise.all([mkdir(appRoot),mkdir(paperRoot)]);
  const configPath=path.join(base,'config.json');
  const raw=defaultUnifiedConfig(appRoot,configPath);
  const program="process.stdout.write(JSON.stringify({cwd:process.cwd(),environment:process.env.NODE_ENV,globalCI:process.env.CI??null}));";
  const config={...raw,workspaces:[
    {...raw.workspaces[0],executionProfile:'app'},
    {root:paperRoot,id:'papers',executionProfile:'research'},
    {root:offlineRoot,id:'offline',onUnavailable:'skip'},
    {root:path.join(base,'disabled'),id:'disabled',enabled:false},
  ],execution:{...raw.execution,mode:'trusted-host',env:{CI:'true'},allowedExecutables:{globalOnly:process.execPath},profiles:{
    app:{allowedExecutables:{node:{command:'${nodePath}',args:['-e',program]}},env:{NODE_ENV:'development'}},
    research:{allowedExecutables:{node:{command:'${nodePath}',args:['-e',program]}},env:{NODE_ENV:'test'}},
  }}};
  await writeFile(configPath,JSON.stringify(config));
  t.after(async()=>{assert.equal(path.dirname(await realpath(base)),parent);assert.ok(path.basename(base).startsWith('webcodex-v010-mcp-'));await rm(base,{recursive:true,force:true});});
  return{configPath,raw,appRoot,paperRoot,offlineRoot};
}
async function connect(configPath:string,transport:'stdio'|'http') {
  const client=new Client({name:'v010-workspaces',version:'1'});
  if(transport==='stdio') {
    const channel=new StdioClientTransport({command:process.execPath,args:[cli,'serve','--config',configPath],stderr:'pipe'});
    channel.stderr?.on('data',()=>{});
    await client.connect(channel);return{client,close:()=>client.close()};
  }
  const app=new App(await loadConfig(configPath)),token=randomUUID()+randomUUID();
  const listener=await startHttp(app,{token,port:0});
  await client.connect(new StreamableHTTPClientTransport(new URL(listener.url),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  return{client,close:async()=>{await client.close();await listener.close();await app.close();}};
}

for(const transport of ['stdio','http'] as const) test(`v0.10 ${transport} serves healthy workspaces with independent profiles while an offline root requires explicit restart`,async t=>{
  const f=await fixture(t);
  let connection=await connect(f.configPath,transport);
  const owner={expected_device_id:f.raw.device.id};
  const jobInput={...owner,workspace_id:'default',executable:'node',idempotency_key:'profile-job'};
  let firstJob:string;
  try {
    const call=(name:string,args:Record<string,unknown>={})=>connection.client.callTool({name,arguments:args});
    const tools=(await connection.client.listTools()).tools;
    assert.equal(tools.length,65);assert.equal(tools.find(tool=>tool.name==='workspace_health')?.annotations?.readOnlyHint,true);
    assert.equal(result(await call('system_status')).version,VERSION);
    const list=result(await call('workspace_list'));
    assert.deepEqual(list.workspaces.map((w:any)=>w.status),['available','available','missing','disabled']);
    assert.deepEqual(list.workspaces[0].execution.executable_aliases,['node']);
    assert.equal(list.workspaces[1].execution.profile,'research');
    assert.equal(error(await call('exec_start',{...jobInput,executable:'globalOnly'})),'EXECUTABLE_NOT_ALLOWED');
    assert.equal(error(await call('fs_read',{workspace_id:'disabled',path:'file.txt'})),'WORKSPACE_DISABLED');
    assert.equal(error(await call('workspace_open',{workspace_id:'offline'})),'WORKSPACE_UNAVAILABLE');
    const opened=result(await call('workspace_open',{workspace_id:'papers'}));
    assert.equal(opened.execution.profile,'research');assert.deepEqual(opened.execution.configured_environment_names,['NODE_ENV']);
    const receipts=[];
    for(const workspace_id of ['default','papers']) {
      const job=result(await call('exec_start',{...jobInput,workspace_id}));
      receipts.push(job.job_id);
      let ended=job;
      for(let attempt=0;attempt<10&&!['succeeded','failed'].includes(ended.status);attempt++) ended=result(await call('exec_wait',{workspace_id,job_id:job.job_id,wait_ms:2000}));
      assert.equal(ended.status,'succeeded');assert.equal(ended.exit_code,0);
      const poll=result(await call('exec_poll',{workspace_id,job_id:job.job_id}));
      const actual=JSON.parse(poll.output.map((chunk:any)=>chunk.text).join(''));
      assert.equal(actual.cwd,workspace_id==='default'?f.appRoot:f.paperRoot);
      assert.equal(actual.environment,workspace_id==='default'?'development':'test');assert.equal(actual.globalCI,null);
      assert.equal(poll.execution_profile,workspace_id==='default'?'app':'research');
    }
    firstJob=receipts[0];assert.notEqual(receipts[0],receipts[1]);
    const written=result(await call('fs_write',{...owner,workspace_id:'papers',path:'note.txt',content:'healthy project remains usable',expected_sha256:null,idempotency_key:'healthy-write'}));
    assert.ok(written.change_id);assert.equal(await readFile(path.join(f.paperRoot,'note.txt'),'utf8'),'healthy project remains usable');
    await mkdir(f.offlineRoot);
    assert.equal(result(await call('workspace_health',{workspace_id:'offline'})).workspaces[0].status,'restart_required');
    assert.equal(error(await call('fs_write',{...owner,workspace_id:'offline',path:'note.txt',content:'must wait',expected_sha256:null,idempotency_key:'not-yet'})),'WORKSPACE_RESTART_REQUIRED');
  } finally {await connection.close();}
  connection=await connect(f.configPath,transport);
  try {
    const call=(name:string,args:Record<string,unknown>={})=>connection.client.callTool({name,arguments:args});
    assert.equal(result(await call('workspace_health',{workspace_id:'offline'})).workspaces[0].status,'available');
    assert.equal(result(await call('exec_start',jobInput)).job_id,firstJob!);
    result(await call('fs_write',{...owner,workspace_id:'offline',path:'note.txt',content:'available after restart',expected_sha256:null,idempotency_key:'after-restart'}));
    assert.equal(await readFile(path.join(f.offlineRoot,'note.txt'),'utf8'),'available after restart');
  } finally {await connection.close();}
});
