import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {defaultConfig} from '../src/config.js';
import {App} from '../src/app.js';

async function fixture(t:TestContext){
  const parent=await realpath(tmpdir()),base=await mkdtemp(path.join(parent,'webcodex-job-observation-'));
  const root=path.join(base,'project'),other=path.join(base,'other');await Promise.all([mkdir(root),mkdir(other)]);
  const configPath=path.join(base,'config.json'),raw=defaultConfig(root,configPath);
  const app=new App({...raw,configPath,execution:{...raw.execution,mode:'trusted-host',maxTimeoutMs:10000},workspaces:[...raw.workspaces,{id:'other',root:other,name:'Other',readOnly:false}]});
  t.after(async()=>{await app.close();assert.equal(path.dirname(await realpath(base)),parent);assert.ok(path.basename(base).startsWith('webcodex-job-observation-'));await rm(base,{recursive:true,force:true});});
  const start=(code:string)=>app.jobs.start({workspace_id:'default',executable:'node',args:['-e',code],idempotency_key:randomUUID()});
  return{app,start};
}
async function finish(app:App,id:string){
  let cursor=0;
  for(let index=0;index<100;index++){
    const result=await app.jobs.wait({workspace_id:'default',job_id:id,cursor,wait_ms:1000});cursor=result.next_cursor;
    if(result.terminal)return result;
  }
  throw new Error('Synthetic job did not finish within the test deadline.');
}
test('wait returns on delayed output and then observes the actual exit code',async t=>{
  const {app,start}=await fixture(t);
  const job=await start("setTimeout(()=>process.stdout.write('测试😀'),150);setTimeout(()=>process.exit(7),450)");
  const first=await app.jobs.wait({workspace_id:'default',job_id:job.job_id,wait_ms:2000});
  assert.equal(first.output.map(chunk=>chunk.text).join(''),'测试😀');
  assert.ok(['output','terminal'].includes(first.wait_reason));assert.ok(first.waited_ms<2000);
  const last=await finish(app,job.job_id);assert.equal(last.status,'failed');assert.equal(last.exit_code,7);assert.equal(last.terminal,true);
  const observed=await app.jobs.wait({workspace_id:'default',job_id:job.job_id,cursor:last.next_cursor,wait_ms:2000});
  assert.equal(observed.wait_reason,'terminal');assert.ok(observed.waited_ms<250);
});
test('silent process failure remains distinct from an exhausted output cursor or a wait timeout',async t=>{
  const {app,start}=await fixture(t);
  const silent=await start('process.exitCode=255');
  const failed=await finish(app,silent.job_id);
  assert.equal(failed.status,'failed');assert.equal(failed.exit_code,255);assert.equal(failed.output_bytes,0);
  assert.equal(failed.failure_diagnostics?.code,'PROCESS_EXIT_WITHOUT_OUTPUT');
  const listed=app.jobs.list({workspace_id:'default'}).jobs.find(job=>job.job_id===silent.job_id);
  assert.deepEqual(listed?.failure_diagnostics,failed.failure_diagnostics);
  const withError=await start("process.stderr.write('SYNTHETIC_AUTH_DIAGNOSTIC');process.exitCode=255");
  await finish(app,withError.job_id);
  const output=app.jobs.poll({workspace_id:'default',job_id:withError.job_id});
  const drained=await app.jobs.wait({workspace_id:'default',job_id:withError.job_id,cursor:output.next_cursor});
  assert.deepEqual(drained.output,[]);assert.ok(drained.output_bytes>0);
  assert.equal(drained.failure_diagnostics,undefined);
  assert.equal(app.jobs.tail({workspace_id:'default',job_id:withError.job_id,stream:'stderr'}).output.map(c=>c.text).join(''),'SYNTHETIC_AUTH_DIAGNOSTIC');
});

test('bounded waits time out without changing the job and reject excessive arguments',async t=>{
  const {app,start}=await fixture(t);const job=await start('setInterval(()=>{},1000)');
  const input={workspace_id:'default',job_id:job.job_id};
  const result=await app.jobs.wait({...input,wait_ms:50});assert.equal(result.wait_reason,'timeout');assert.equal(result.terminal,false);assert.ok(result.waited_ms>=35);
  assert.equal(result.failure_diagnostics,undefined);
  app.ctx.config.execution.maxWaitMs=60;app.ctx.config.execution.defaultWaitMs=10;
  await assert.rejects(app.jobs.wait({...input,wait_ms:61}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(app.jobs.wait({...input,max_bytes:app.ctx.config.limits.readMaxBytes+1}),{code:'INVALID_ARGUMENT'});
  const zero=await app.jobs.wait({...input,wait_ms:0});assert.equal(zero.terminal,false);assert.equal(zero.wait_reason,'timeout');
});
test('service closure releases pending waits before the store closes',async t=>{
  const {app,start}=await fixture(t);const job=await start('setInterval(()=>{},1000)');
  const observed=assert.rejects(app.jobs.wait({workspace_id:'default',job_id:job.job_id,wait_ms:20000}),{code:'SERVICE_CLOSING'});
  await app.jobs.close();await observed;
  assert.equal(app.jobs.poll({workspace_id:'default',job_id:job.job_id}).status,'cancelled');
});
test('wait checks identity again before returning and tail rejects another workspace',async t=>{
  const {app,start}=await fixture(t);const job=await start('setInterval(()=>{},1000)');
  assert.throws(()=>app.jobs.tail({workspace_id:'other',job_id:job.job_id}),{code:'JOB_NOT_FOUND'});
  await assert.rejects(app.jobs.wait({workspace_id:'other',job_id:job.job_id}),{code:'JOB_NOT_FOUND'});
  const observed=assert.rejects(app.jobs.wait({workspace_id:'default',job_id:job.job_id,wait_ms:50}),{code:'WORKSPACE_IDENTITY_MISMATCH'});
  app.ctx.config.workspaces[0].uid=randomUUID();
  try{await observed;}finally{delete app.ctx.config.workspaces[0].uid;}
});
test('tail selects the last UTF8 bytes and stderr while preserving global polling cursors',async t=>{
  const {app,start}=await fixture(t);
  const job=await start("process.stdout.write('开始😀');setTimeout(()=>process.stderr.write('错误甲😀'),50);setTimeout(()=>process.stdout.write('结尾乙😀'),100)");
  await finish(app,job.job_id);
  const input={workspace_id:'default',job_id:job.job_id};
  const all=app.jobs.tail({...input,max_bytes:7});assert.equal(all.output.map(chunk=>chunk.text).join(''),'乙😀');assert.equal(all.returned_bytes,7);
  assert.equal(all.earlier_output_omitted,true);assert.equal(all.other_streams_omitted,false);assert.equal(all.terminal,true);
  const errors=app.jobs.tail({...input,max_bytes:8,stream:'stderr'});assert.equal(errors.output.map(chunk=>chunk.text).join(''),'甲😀');assert.equal(errors.returned_bytes,7);
  assert.equal(errors.other_streams_omitted,true);assert.equal(errors.earlier_output_omitted,true);assert.equal(errors.output[0].stream,'stderr');
  const end=app.jobs.poll({...input,cursor:errors.next_cursor});assert.equal(end.output.length,0);assert.equal(end.has_more,false);
  const complete=app.jobs.tail({...input,max_bytes:65536});assert.equal(complete.earlier_output_omitted,false);assert.ok(complete.output.every(chunk=>!chunk.text.includes('\ufffd')));
  assert.throws(()=>app.jobs.tail({...input,stream:'invalid' as 'all'}),{code:'INVALID_ARGUMENT'});
});
test('tail reports truncated storage explicitly',async t=>{
  const {app,start}=await fixture(t);app.ctx.config.execution.maxOutputBytes=1024;
  const job=await start("process.stdout.write('x'.repeat(4096))");await finish(app,job.job_id);
  const result=app.jobs.tail({workspace_id:'default',job_id:job.job_id,max_bytes:32});
  assert.equal(result.returned_bytes,32);assert.equal(result.output_truncated,true);assert.equal(result.earlier_output_omitted,true);
  assert.equal(result.next_cursor,1024);assert.equal(result.scope,'tail_of_persisted_output');
});

test('tail caps tiny persisted chunks and preserves exact global offsets',async t=>{
  const {app,start}=await fixture(t);const job=await start('process.exit(0)');await finish(app,job.job_id);
  const insert=app.store.db.prepare('INSERT INTO webcodex_job_chunks(job_id,start_cursor,end_cursor,stream,text) VALUES(?,?,?,?,?)');
  for(let index=0;index<300;index++)insert.run(job.job_id,index,index+1,'stdout','x');
  app.store.db.prepare('UPDATE webcodex_jobs SET output_bytes=300 WHERE job_id=?').run(job.job_id);
  const result=app.jobs.tail({workspace_id:'default',job_id:job.job_id,max_bytes:1024});
  assert.equal(result.output.length,256);assert.equal(result.returned_bytes,256);assert.equal(result.earlier_output_omitted,true);
  assert.equal(result.start_cursor,44);assert.equal(result.next_cursor,300);assert.equal(result.output[255].end_cursor,300);
});
