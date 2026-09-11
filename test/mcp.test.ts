import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultConfig,loadConfig } from '../src/config.js';
import { App } from '../src/app.js';
import { startHttp } from '../src/http.js';

async function fixture() {
  const base=await mkdtemp(path.join(await realpath(tmpdir()),'webcodex-mcp-'));const root=path.join(base,'project');await mkdir(root);
  const configPath=path.join(base,'config.json');const raw=defaultConfig(root,configPath);raw.execution.mode='trusted-host' as any;
  await writeFile(configPath,JSON.stringify(raw));const config=await loadConfig(configPath);
  await writeFile(path.join(root,'app.js'),'console.log("before");\n');
  return{base,root,configPath,config,clean:async()=>{assert.ok(path.basename(base).startsWith('webcodex-mcp-'));await rm(base,{recursive:true,force:true});}};
}
function result(value:any) {assert.equal(value.isError,undefined,JSON.stringify(value));assert.equal(value.structuredContent?.ok,true);return value.structuredContent.data;}
async function codingLoop(client:Client,root:string) {
  const advertised=await client.listTools();assert.equal(advertised.tools.length,65);
  const byName=new Map(advertised.tools.map(t=>[t.name,t]));
  for(const name of ['attachment_bind','attachment_start','attachment_status','attachment_cancel']) assert.equal(byName.has(name),false);
  assert.equal(byName.get('fs_read')?.annotations?.readOnlyHint,true);
  assert.equal(byName.get('exec_start')?.annotations?.readOnlyHint,false);
  assert.equal(byName.get('fs_write')?.annotations?.destructiveHint,true);
  assert.equal(byName.get('fs_read_many')?.annotations?.readOnlyHint,true);
  assert.equal(byName.get('changes_preview')?.annotations?.readOnlyHint,true);
  for (const name of ['codex_session_list', 'codex_session_read', 'codex_session_handoff', 'codex_session_search', 'checkpoint_read']) assert.equal(byName.get(name)?.annotations?.readOnlyHint,true);
  assert.equal(byName.get('checkpoint_save')?.annotations?.readOnlyHint,false);
  assert.equal(byName.get('checkpoint_save')?.annotations?.idempotentHint,true);
  const call=(name:string,args:any={})=>client.callTool({name,arguments:args});
  assert.equal(result(await call('workspace_list')).workspaces[0].workspace_id,'default');
  assert.equal((await call('codex_session_list')).isError, true);
  result(await call('workspace_open',{workspace_id:'default'}));
  const read=result(await call('fs_read',{workspace_id:'default',path:'app.js'}));
  const batch=result(await call('fs_read_many',{workspace_id:'default',files:[{path:'app.js'},{path:'API_key.txt'}]}));
  assert.equal(batch.results[0].data.sha256,read.sha256);
  assert.equal(batch.results[0].data.content,read.content);
  assert.equal(batch.results[1].error.code,'PATH_DENIED');
  const edit=result(await call('fs_write',{workspace_id:'default',path:'app.js',content:'console.log("测试通过");\n',expected_sha256:read.sha256,idempotency_key:'integration-edit'}));
  assert.equal(await readFile(path.join(root,'app.js'),'utf8'),'console.log("测试通过");\n');
  const conflict=await call('fs_write',{workspace_id:'default',path:'app.js',content:'bad',expected_sha256:read.sha256,idempotency_key:'conflicting-edit'});
  assert.equal(conflict.isError,true);
  const job=result(await call('exec_start',{workspace_id:'default',executable:'node',args:['app.js'],idempotency_key:'integration-test'}));
  let logs='';let cursor=0;let final:any;
  for(let i=0;i<100;i++){
    const poll=result(await call('exec_poll',{workspace_id:'default',job_id:job.job_id,cursor}));
    logs+=poll.output.map((c:any)=>c.text).join('');cursor=poll.next_cursor;
    if(!['queued','running'].includes(poll.status)){final=poll;break;}
    await new Promise(r=>setTimeout(r,20));
  }
  assert.equal(final?.status,'succeeded');assert.equal(final?.exit_code,0);assert.match(logs,/测试通过/);
  const duplicate=result(await call('exec_start',{workspace_id:'default',executable:'node',args:['app.js'],idempotency_key:'integration-test'}));assert.equal(duplicate.job_id,job.job_id);
  assert.equal(result(await call('checkpoint_read',{workspace_id:'default'})).exists,false);
  const checkpointInput = {workspace_id:'default',objective:'Continue emergency work',progress:'Changed app.js',next_steps:'Review diff and return to Codex',verification_notes:'The selected job ran app.js.',job_ids:[job.job_id],expected_sha256:null,idempotency_key:'integration-checkpoint'};
  const saved = result(await call('checkpoint_save',checkpointInput));
  const checkpoint = result(await call('checkpoint_read',{workspace_id:'default'}));
  assert.equal(checkpoint.sha256,saved.sha256);
  assert.match(checkpoint.content,/"exit_code": 0/);
  assert.match(checkpoint.content,/not independently verified/);
  assert.equal(result(await call('workspace_open',{workspace_id:'default'})).checkpoint.exists,true);
  assert.equal(result(await call('checkpoint_save',checkpointInput)).saved_at,saved.saved_at);
  const checkpointConflict = await call('checkpoint_save',{...checkpointInput,idempotency_key:'conflicting-checkpoint'});
  assert.equal((checkpointConflict.structuredContent as any).error.code,'VERSION_CONFLICT');
  const preview=result(await call('changes_preview',{workspace_id:'default',change_id:edit.change_id}));
  assert.equal(preview.direction,'restore');
  assert.equal(preview.current_sha256,edit.sha256);
  assert.equal(preview.restore_sha256,read.sha256);
  assert.match(preview.diff,/-console\.log\("测试通过"\)/);
  assert.match(preview.diff,/\+console\.log\("before"\)/);
  result(await call('changes_restore',{workspace_id:'default',change_id:edit.change_id,expected_sha256:edit.sha256,idempotency_key:'integration-restore'}));
  assert.equal(await readFile(path.join(root,'app.js'),'utf8'),'console.log("before");\n');
  const denied=await call('fs_read',{workspace_id:'default',path:'../config.json'});assert.equal(denied.isError,true);
}
test('real stdio MCP client completes read/edit/execute/restore loop',async()=>{
  const f=await fixture();const client=new Client({name:'webcodex-test',version:'1.0'});
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
  const transport=new StdioClientTransport({command:process.execPath,args:[cli,'serve','--config',f.configPath,'--transport','stdio'],stderr:'pipe'});
  let diagnostics='';transport.stderr?.on('data',(b:Buffer)=>{diagnostics+=b.toString();});
  try{await client.connect(transport);await codingLoop(client,f.root);}
  finally{await client.close();await new Promise(r=>setTimeout(r,150));await f.clean();}
});
test('HTTP requires token, rejects browser origins and shares persistent jobs across stateless requests',async()=>{
  const f=await fixture();const app=new App(f.config);const token=randomBytes(32).toString('hex');
  const listener=await startHttp(app,{token,port:0});const client=new Client({name:'webcodex-http-test',version:'1.0'});
  try {
    assert.equal((await fetch(listener.url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    assert.equal((await fetch(listener.url,{method:'POST',headers:{Origin:'https://evil.example',Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'})).status,403);
    const badHost=await new Promise<number|undefined>((resolve,reject)=>{const req=request(listener.url,{method:'POST',headers:{Host:'evil.example',Authorization:'Bearer '+token,'Content-Type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('{}');});
    assert.equal(badHost,403);
    assert.equal((await fetch(listener.url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'broken'})).status,400);
    await client.connect(new StreamableHTTPClientTransport(new URL(listener.url),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    await codingLoop(client,f.root);
  }finally{await client.close();await listener.close();await app.close();await f.clean();}
});
