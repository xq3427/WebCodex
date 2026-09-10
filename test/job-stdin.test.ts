import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { App } from '../src/app.js';
import { defaultConfig } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

async function fixture(t:TestContext,overrides:Partial<AppConfig['execution']>={}) {
  const parent=await realpath(tmpdir()),base=await mkdtemp(path.join(parent,'webcodex-stdin-'));
  const root=path.join(base,'project'),other=path.join(base,'other');await Promise.all([mkdir(root),mkdir(other)]);
  const configPath=path.join(base,'config.json'),raw=defaultConfig(root,configPath);
  const config:AppConfig={...raw,configPath,execution:{...raw.execution,mode:'trusted-host',maxTimeoutMs:10000,...overrides},workspaces:[...raw.workspaces,{id:'other',root:other,name:'Other',readOnly:false}]};
  let app=new App(config);
  t.after(async()=>{await app.close();const actual=await realpath(base);assert.equal(path.dirname(actual),parent);assert.ok(path.basename(actual).startsWith('webcodex-stdin-'));await rm(actual,{recursive:true,force:true});});
  return {get app(){return app;},config,start:(code:string,stdin:'closed'|'pipe'='pipe')=>app.jobs.start({workspace_id:'default',executable:'node',args:['-e',code],stdin,idempotency_key:randomUUID()}),restart:async()=>{await app.close();app=new App(config);}};
}
async function ended(app:App,jobId:string) {
  let cursor=0;
  for(let attempt=0;attempt<100;attempt++) {
    const result=await app.jobs.wait({workspace_id:'default',job_id:jobId,cursor,wait_ms:500});cursor=result.next_cursor;
    if(result.terminal)return app.jobs.poll({workspace_id:'default',job_id:jobId});
  }
  throw new Error('Fixture process did not finish.');
}
const write=(app:App,jobId:string,content:string,end=false,key=randomUUID())=>app.jobs.writeStdin({workspace_id:'default',job_id:jobId,content,end,idempotency_key:key});

test('stdin transports UTF8 text and EOF once, with real digest output and persisted retry results',async t=>{
  const f=await fixture(t),job=await f.start("const h=require('node:crypto').createHash('sha256');let n=0;process.stdin.on('data',b=>{n+=b.length;h.update(b)});process.stdin.on('end',()=>console.log(JSON.stringify({n,sha:h.digest('hex')})))");
  const secret='sk-proj-'+'Z'.repeat(70),first='中文😀\n'+secret;
  const input={workspace_id:'default',job_id:job.job_id,content:first,idempotency_key:'first-input'};
  const [written,retry]=await Promise.all([f.app.jobs.writeStdin(input),f.app.jobs.writeStdin(input)]);
  assert.deepEqual(written,retry);assert.equal(written.bytes_written,Buffer.byteLength(first));assert.equal(written.delivery,'written_to_pipe');
  const last={workspace_id:'default',job_id:job.job_id,content:'\nend',end:true,idempotency_key:'last-input'};
  const eof=await f.app.jobs.writeStdin(last),result=await ended(f.app,job.job_id);
  assert.equal(result.exit_code,0);assert.equal(result.stdin.mode,'pipe');assert.equal(result.stdin.state,'ended');
  const actual=JSON.parse(result.output.map(chunk=>chunk.text).join(''));
  assert.equal(actual.n,Buffer.byteLength(first+'\nend'));assert.equal(actual.sha,createHash('sha256').update(first+'\nend').digest('hex'));
  assert.equal(result.stdin.bytes_attempted,actual.n);
  const operations=f.app.store.db.prepare('SELECT * FROM operations').all(),audit=f.app.store.db.prepare('SELECT * FROM audit_events').all();
  assert.equal(JSON.stringify([operations,audit]).includes(secret),false);
  await assert.rejects(write(f.app,job.job_id,'again'),{code:'JOB_NOT_WRITABLE'});
  await f.restart();
  assert.deepEqual(await f.app.jobs.writeStdin(input),written);assert.deepEqual(await f.app.jobs.writeStdin(last),eof);
  await assert.rejects(f.app.jobs.writeStdin({...input,content:'changed'}),{code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(f.app.jobs.poll({workspace_id:'default',job_id:job.job_id}).stdin.bytes_attempted,actual.n);
});

test('stdin is opt-in and empty EOF is distinct from an empty no-op',async t=>{
  const f=await fixture(t),closed=await f.start('setTimeout(()=>{},1000)','closed');
  assert.equal(closed.stdin.mode,'closed');
  await assert.rejects(write(f.app,closed.job_id,'hello'),{code:'STDIN_NOT_ENABLED'});
  const pipe=await f.start("process.stdin.resume();process.stdin.on('end',()=>console.log('EOF'))");
  await assert.rejects(write(f.app,pipe.job_id,''),{code:'INVALID_ARGUMENT'});
  await assert.rejects(write(f.app,pipe.job_id,'\ud800'),{code:'INVALID_ARGUMENT'});
  assert.equal((await write(f.app,pipe.job_id,'',true)).bytes_written,0);
  const result=await ended(f.app,pipe.job_id);assert.equal(result.exit_code,0);assert.match(result.output.map(chunk=>chunk.text).join(''),/EOF/);
});

test('stdin enforces UTF8 and cumulative budgets across concurrent requests',async t=>{
  const f=await fixture(t,{stdinMaxBytes:6,stdinMaxTotalBytes:9});
  const job=await f.start("let n=0;process.stdin.on('data',b=>n+=b.length);process.stdin.on('end',()=>console.log(n))");
  await assert.rejects(write(f.app,job.job_id,'😀😀'),{code:'STDIN_LIMIT_EXCEEDED'});
  const responses=await Promise.allSettled([write(f.app,job.job_id,'中文'),write(f.app,job.job_id,'测试')]);
  assert.equal(responses.filter(item=>item.status==='fulfilled').length,1);
  assert.equal((responses.find(item=>item.status==='rejected') as PromiseRejectedResult).reason.code,'STDIN_LIMIT_EXCEEDED');
  await write(f.app,job.job_id,'!',true);
  const result=await ended(f.app,job.job_id);assert.equal(result.stdin.bytes_attempted,7);assert.equal(result.output.map(chunk=>chunk.text).join('').trim(),'7');
});

test('stdin rejects disabled execution, another workspace and read-only changes even on retries',async t=>{
  const f=await fixture(t),job=await f.start('process.stdin.resume()');
  const input={workspace_id:'default',job_id:job.job_id,content:'ok',idempotency_key:'retry-policy'};
  await f.app.jobs.writeStdin(input);
  await assert.rejects(f.app.jobs.writeStdin({...input,workspace_id:'other'}),{code:'JOB_NOT_FOUND'});
  f.app.ctx.config.execution.mode='disabled';
  await assert.rejects(f.app.jobs.writeStdin(input),{code:'EXECUTION_DISABLED'});
  f.app.ctx.config.execution.mode='trusted-host';f.app.ctx.config.workspaces[0].readOnly=true;
  await assert.rejects(f.app.jobs.writeStdin(input),{code:'READ_ONLY'});
  f.app.ctx.config.workspaces[0].readOnly=false;
  f.app.ctx.config.workspaces[0].uid=randomUUID();
  await assert.rejects(f.app.jobs.writeStdin(input),{code:'WORKSPACE_IDENTITY_MISMATCH'});
  delete f.app.ctx.config.workspaces[0].uid;
  await write(f.app,job.job_id,'',true);assert.equal((await ended(f.app,job.job_id)).exit_code,0);
});

test('stdin backpressure timeout is unknown delivery and cannot be blindly retried',async t=>{
  const f=await fixture(t,{stdinMaxBytes:1048576,stdinMaxTotalBytes:2097152,stdinWriteTimeoutMs:100});
  const job=await f.start("setInterval(()=>{},1000)");
  const input={workspace_id:'default',job_id:job.job_id,content:'x'.repeat(1048576),idempotency_key:'large-input'};
  await assert.rejects(f.app.jobs.writeStdin(input),{code:'STDIN_DELIVERY_UNKNOWN'});
  const state=f.app.jobs.poll({workspace_id:'default',job_id:job.job_id});assert.equal(state.stdin.state,'unknown');assert.equal(state.stdin.bytes_attempted,1048576);
  await assert.rejects(f.app.jobs.writeStdin(input),{code:'STDIN_DELIVERY_UNKNOWN'});
  await assert.rejects(write(f.app,job.job_id,'new input'),{code:'STDIN_CLOSED'});
  assert.equal(f.app.jobs.poll({workspace_id:'default',job_id:job.job_id}).stdin.bytes_attempted,1048576);
});

test('stdin shutdown settles active pipe writes before the state database closes',async t=>{
  const f=await fixture(t,{stdinMaxBytes:1048576,stdinMaxTotalBytes:2097152});
  const job=await f.start('setInterval(()=>{},1000)');
  const pending=f.app.jobs.writeStdin({workspace_id:'default',job_id:job.job_id,content:'y'.repeat(1048576),idempotency_key:'shutdown-input'});
  const observed=pending.then(()=>({ok:true}),error=>({ok:false,code:error.code}));
  // Let authorization reach the pipe; shutdown must also work if it is still queued.
  await new Promise(resolve=>setTimeout(resolve,20));
  await f.app.close();assert.equal((await observed).ok,false);
  await assert.rejects(write(f.app,job.job_id,'late'),{code:'SERVICE_CLOSING'});
});

test('stdin restart never reattaches a recorded running PID or replays an uncertain operation',async t=>{
  const f=await fixture(t),job=await f.start('process.stdin.resume()');
  const input={workspace_id:'default',job_id:job.job_id,content:'uncertain',idempotency_key:'before-restart'};
  await f.app.jobs.writeStdin(input);
  await write(f.app,job.job_id,'',true);await ended(f.app,job.job_id);
  f.app.store.db.prepare("UPDATE operations SET status='pending',result=NULL WHERE op_key='before-restart'").run();
  f.app.store.db.prepare("UPDATE webcodex_jobs SET status='running',stdin_state='open',pid=12345 WHERE job_id=?").run(job.job_id);
  await f.restart();
  const state=f.app.jobs.poll({workspace_id:'default',job_id:job.job_id});assert.equal(state.status,'unknown');assert.equal(state.stdin.state,'unknown');
  await assert.rejects(f.app.jobs.writeStdin(input),{code:'EXECUTION_UNKNOWN'});
  await assert.rejects(write(f.app,job.job_id,'must not run'),{code:'JOB_NOT_WRITABLE'});
  assert.equal(f.app.jobs.poll({workspace_id:'default',job_id:job.job_id}).stdin.bytes_attempted,Buffer.byteLength(input.content));
});
