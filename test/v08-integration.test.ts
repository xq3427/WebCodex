import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, stat } from 'node:fs/promises';
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

const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
function data(result:any):any {assert.equal(result.isError,undefined,JSON.stringify(result));assert.equal(result.structuredContent?.ok,true);return result.structuredContent.data;}
function code(result:any):string {assert.equal(result.isError,true);return result.structuredContent.error.code;}
async function fixture(t:TestContext) {
  const parent=await realpath(tmpdir()),base=await mkdtemp(path.join(parent,'webcodex-v08-mcp-'));
  const root=path.join(base,'项目 with spaces'),configPath=path.join(base,'config.json');await mkdir(root);
  const raw=defaultUnifiedConfig(root,configPath,{deviceName:'Synthetic v08 device'});
  await writeFile(configPath,JSON.stringify({...raw,execution:{...raw.execution,mode:'trusted-host'}}));
  await Promise.all([
    writeFile(path.join(root,'lib.cjs'),'module.exports = 1;\n'),
    writeFile(path.join(root,'old.txt'),'move this file\n'),writeFile(path.join(root,'unused.txt'),'delete this file\n'),
    writeFile(path.join(root,'verify.cjs'),"const assert=require('node:assert/strict');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{assert.equal(require('./lib.cjs'),2);assert.equal(input,'中文😀\\n');console.log('V08_INPUT_OK');});")
  ]);
  t.after(async()=>{const actual=await realpath(base);assert.equal(path.dirname(actual),parent);assert.ok(path.basename(actual).startsWith('webcodex-v08-mcp-'));await rm(actual,{recursive:true,force:true});});
  return {root,configPath,config:await loadConfig(configPath)};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function connect(f:Fixture,transport:'stdio'|'http') {
  const client=new Client({name:'v08-integration',version:'1'});
  if(transport==='stdio') {
    const channel=new StdioClientTransport({command:process.execPath,args:[cli,'serve','--config',f.configPath],stderr:'pipe'});
    channel.stderr?.on('data',()=>{});await client.connect(channel);return {client,close:()=>client.close()};
  }
  const app=new App(f.config),token=randomUUID()+randomUUID(),listener=await startHttp(app,{token,port:0});
  await client.connect(new StreamableHTTPClientTransport(new URL(listener.url),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  return {client,close:async()=>{await client.close();await listener.close();await app.close();}};
}

async function exercise(client:Client,f:Fixture) {
  const call=(name:string,input:Record<string,unknown>={})=>client.callTool({name,arguments:input});
  const status=data(await call('system_status'));assert.equal(status.version,VERSION);
  const ws={workspace_id:'default'},owner={...ws,expected_device_id:status.device_id};
  const tools=(await client.listTools()).tools;assert.equal(tools.length,72);
  for(const name of ['fs_batch_preview','fs_batch_status'])assert.equal(tools.find(tool=>tool.name===name)?.annotations?.readOnlyHint,true);
  for(const name of ['fs_batch_apply','exec_write_stdin']) {
    const tool=tools.find(tool=>tool.name===name)!;assert.ok(tool.inputSchema.required?.includes('expected_device_id'));
    assert.equal(tool.annotations?.idempotentHint,true);assert.equal(tool.annotations?.destructiveHint,true);
  }
  const before=data(await call('fs_read_many',{...ws,files:[{path:'lib.cjs'},{path:'old.txt'},{path:'unused.txt'}]}));
  const [lib,old,unused]=before.results.map((item:any)=>item.data);
  const changes=[
    {op:'patch',path:'lib.cjs',expected_sha256:lib.sha256,patch:'--- a/lib.cjs\n+++ b/lib.cjs\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n'},
    {op:'write',path:'new.txt',expected_sha256:null,content:'created together\n'},
    {op:'move',path:'old.txt',to:'moved.txt',expected_sha256:old.sha256},
    {op:'delete',path:'unused.txt',expected_sha256:unused.sha256}
  ];
  const preview=data(await call('fs_batch_preview',{...ws,changes,max_bytes:4096}));
  assert.equal(preview.persisted,false);assert.equal(preview.atomic,false);assert.equal(preview.changes.length,4);assert.equal(preview.path_count,5);
  assert.equal(await readFile(path.join(f.root,'lib.cjs'),'utf8'),lib.content);await assert.rejects(stat(path.join(f.root,'new.txt')),{code:'ENOENT'});
  assert.equal(data(await call('fs_batch_status',{...ws,idempotency_key:'batch-one'})).exists,false);
  const small=data(await call('fs_batch_preview',{...ws,changes,max_bytes:8}));assert.equal(small.truncated,true);assert.equal(small.changes.length,4);assert.equal(small.plan_sha256,preview.plan_sha256);
  const input={...owner,changes,expected_plan_sha256:preview.plan_sha256,idempotency_key:'batch-one'};
  assert.equal(code(await call('fs_batch_apply',{...input,expected_device_id:randomUUID()})),'DEVICE_MISMATCH');
  assert.equal(code(await call('fs_batch_apply',{...input,expected_plan_sha256:'0'.repeat(64),idempotency_key:'wrong-plan'})),'BATCH_PLAN_CONFLICT');
  const batch=data(await call('fs_batch_apply',input));assert.equal(batch.status,'applied');assert.equal(batch.steps.length,5);
  assert.equal(await readFile(path.join(f.root,'lib.cjs'),'utf8'),'module.exports = 2;\n');assert.equal(await readFile(path.join(f.root,'moved.txt'),'utf8'),old.content);
  await assert.rejects(stat(path.join(f.root,'old.txt')),{code:'ENOENT'});await assert.rejects(stat(path.join(f.root,'unused.txt')),{code:'ENOENT'});
  assert.equal(data(await call('fs_batch_apply',input)).batch_id,batch.batch_id);
  const observed=data(await call('fs_batch_status',{...ws,idempotency_key:input.idempotency_key}));
  assert.equal(observed.status,'applied');assert.ok(observed.observations.every((row:any)=>['after','both'].includes(row.matches)));
  const history=data(await call('changes_list',ws));assert.ok(history.changes.length>=5);

  const job=data(await call('exec_start',{...owner,executable:'node',args:['verify.cjs'],stdin:'pipe',idempotency_key:'verify-batch'}));assert.equal(job.stdin.mode,'pipe');
  const textInput={...owner,job_id:job.job_id,content:'中文😀',idempotency_key:'verification-input'};
  assert.equal(code(await call('exec_write_stdin',{...textInput,expected_device_id:randomUUID()})),'DEVICE_MISMATCH');
  const sent=data(await call('exec_write_stdin',textInput));assert.equal(sent.bytes_written,10);assert.equal(sent.delivery,'written_to_pipe');
  assert.deepEqual(data(await call('exec_write_stdin',textInput)),sent);
  data(await call('exec_write_stdin',{...owner,job_id:job.job_id,content:'\n',end:true,idempotency_key:'verification-eof'}));
  let cursor=0,final:any,output='';
  for(let attempt=0;attempt<100;attempt++) {
    const page=data(await call('exec_wait',{...ws,job_id:job.job_id,cursor,wait_ms:500}));cursor=page.next_cursor;output+=page.output.map((row:any)=>row.text).join('');
    if(page.terminal&&!page.has_more){final=page;break;}
  }
  assert.equal(final?.status,'succeeded');assert.equal(final.exit_code,0);assert.equal(final.stdin.bytes_attempted,11);assert.match(output,/V08_INPUT_OK/);
  const task=data(await call('task_create',{...owner,title:'Batch and stdin verification',objective:'Apply related changes and verify input',progress:'Program asserted modified module and complete input',next_steps:'Review files',job_ids:[job.job_id],tracked_paths:['lib.cjs','moved.txt','unused.txt'],idempotency_key:'task-after-batch'}));
  const taskRead=data(await call('task_read',{...ws,task_id:task.task_id}));assert.equal(taskRead.freshness.verification_validity,'unknown');
  // Current observations must never silently rewrite a successful historical journal.
  await writeFile(path.join(f.root,'lib.cjs'),'module.exports = 3;\n');
  const changed=data(await call('fs_batch_status',{...ws,idempotency_key:input.idempotency_key}));
  assert.equal(changed.status,'applied');assert.equal(changed.observations.find((row:any)=>row.path==='lib.cjs').matches,'neither');
  assert.equal(data(await call('task_read',{...ws,task_id:task.task_id})).freshness.state,'changed');
  return {input,batchId:batch.batch_id,textInput,sent};
}

for(const transport of ['stdio','http'] as const)test(`v0.8 ${transport} batches and program stdin complete the development loop with durable receipts`,async t=>{
  const f=await fixture(t),first=await connect(f,transport);let saved:Awaited<ReturnType<typeof exercise>>;
  try{saved=await exercise(first.client,f);}finally{await first.close();}
  const second=await connect(f,transport);
  try {
    const call=(name:string,input:Record<string,unknown>)=>second.client.callTool({name,arguments:input});
    assert.equal(data(await call('fs_batch_apply',saved.input)).batch_id,saved.batchId);
    assert.equal(await readFile(path.join(f.root,'lib.cjs'),'utf8'),'module.exports = 3;\n');
    assert.deepEqual(data(await call('exec_write_stdin',saved.textInput)),saved.sent);
    assert.equal(data(await call('fs_batch_status',{workspace_id:'default',idempotency_key:'batch-one'})).status,'applied');
  } finally{await second.close();}
});

test('graceful shutdown drains an active batch receipt before closing SQLite and rejects new calls',async t=>{
  const f=await fixture(t),app=new App(f.config);
  const changes=[{op:'write' as const,path:'shutdown.txt',content:'completed before store closure',expected_sha256:null}];
  const preview=await app.fileBatches.preview({workspace_id:'default',changes});
  let arrived!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{arrived=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const commit=app.files.commitForBatch.bind(app.files);
  app.files.commitForBatch=async(...args)=>{arrived();await gate;return commit(...args);};
  const running=app.runTool(()=>app.fileBatches.apply({workspace_id:'default',changes,expected_plan_sha256:preview.plan_sha256,idempotency_key:'shutdown-batch'}));
  let closing:Promise<void>|undefined;
  try {
    await entered;
    let closed=false;closing=app.close().then(()=>{closed=true;});
    await assert.rejects(app.runTool(async()=>app.status()),{code:'SERVICE_CLOSING'});
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(closed,false);
    release();assert.equal((await running).status,'applied');await closing;
    const reopened=new App(f.config);
    try {
      const result=await reopened.fileBatches.status({workspace_id:'default',idempotency_key:'shutdown-batch'});
      assert.equal(result.status,'applied');assert.equal(await readFile(path.join(f.root,'shutdown.txt'),'utf8'),changes[0].content);
    } finally{await reopened.close();}
  } finally{release();await running.catch(()=>{});await(closing??app.close());}
});
