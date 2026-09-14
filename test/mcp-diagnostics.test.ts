import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { McpDiagnostics, observeMcpTransport, readMcpDiagnostics } from '../src/mcp-diagnostics.js';
import { SERVER_INSTRUCTIONS } from '../src/server-instructions.js';
import { VERSION } from '../src/version.js';

test('real stdio records discovery, SDK schema rejection, device rejection and successful SVG without recording contents', async () => {
  const parent=await realpath(tmpdir()), base=await mkdtemp(path.join(parent,'webcodex-diagnostics-'));
  const root=path.join(base,'workspace');await mkdir(root);
  const configPath=path.join(base,'config.json');
  const raw=defaultUnifiedConfig(root,configPath);raw.diagnostics={enabled:true,maxEvents:20};
  await writeFile(configPath,JSON.stringify(raw));const config=await loadConfig(configPath);
  const client=new Client({name:'diagnostics-client',version:'1.0'});
  let stderr='';
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/cli.js',import.meta.url)),'serve','--config',configPath],stderr:'pipe'});
  transport.stderr?.on('data',data=>{stderr+=String(data);});
  try {
    await client.connect(transport);
    const tools=await client.listTools();assert.equal(tools.tools.length,66);
    assert.match(client.getInstructions()?.slice(0,512)??'',/SVG.*fs_write/s);
    const status:any=(await client.callTool({name:'system_status'})).structuredContent;
    assert.equal(status.data.version,VERSION);assert.equal(status.data.capabilities.command_execution.enabled,false);
    const secret='synthetic-sensitive-content-'+randomUUID();
    const args={workspace_id:'default',path:'diagram.svg',content:'<svg xmlns="http://www.w3.org/2000/svg"><title>'+secret+'</title></svg>',expected_sha256:null,idempotency_key:'svg-'+randomUUID()};
    const invalid=await client.callTool({name:'fs_write',arguments:args});assert.equal(invalid.isError,true);
    const wrong:any=await client.callTool({name:'fs_write',arguments:{...args,expected_device_id:randomUUID()}});
    assert.equal(wrong.structuredContent.error.code,'DEVICE_MISMATCH');
    const created:any=await client.callTool({name:'fs_write',arguments:{...args,expected_device_id:raw.device.id}});
    assert.equal(created.structuredContent.ok,true);
    assert.equal(await readFile(path.join(root,'diagram.svg'),'utf8'),args.content);
    let snapshot:any=readMcpDiagnostics(config,100);
    // Receiving bytes in this process does not mean the server's send promise
    // has resolved and its response_sent diagnostic has committed yet.
    const responded=()=>snapshot.events.some((e:any)=>e.tool==='fs_write'&&e.outcome==='responded');
    const diagnosticDeadline=Date.now()+2000;
    while(!responded()&&Date.now()<diagnosticDeadline){await delay(10);snapshot=readMcpDiagnostics(config,100);}
    assert.equal(snapshot.available,true);
    assert.ok(snapshot.events.some((e:any)=>e.method==='initialize'&&e.outcome==='responded'));
    assert.ok(snapshot.events.some((e:any)=>e.method==='tools/list'&&e.outcome==='responded'));
    assert.ok(snapshot.events.some((e:any)=>e.tool==='fs_write'&&e.stage==='input_validation'&&e.error_code==='-32602'));
    assert.ok(snapshot.events.some((e:any)=>e.tool==='fs_write'&&e.stage==='tool'&&e.error_code==='DEVICE_MISMATCH'));
    assert.ok(snapshot.events.some((e:any)=>e.tool==='fs_write'&&e.outcome==='responded'));
    assert.ok(!JSON.stringify(snapshot).includes(secret));assert.ok(!JSON.stringify(snapshot).includes('diagram.svg'));
    for (let i=0;i<22;i++) await client.callTool({name:'system_status'});
    snapshot=readMcpDiagnostics(config,100);assert.equal(snapshot.events.length,20);
    assert.equal(new Set(snapshot.events.map((e:any)=>e.trace_id)).size,20);
    // Proves read-only diagnostics works while the active daemon holds its state lease.
    assert.equal((await client.callTool({name:'workspace_list'})).isError,undefined);
  } finally {
    await client.close();assert.ok(!stderr.includes('synthetic-sensitive-content-'));
    assert.equal(path.dirname(await realpath(base)),parent);await rm(base,{recursive:true,force:true});
  }
});

test('diagnostic transport preserves SDK callbacks/options, reports send failure and never copies remote request IDs',async()=>{
  const db=new DatabaseSync(':memory:');
  const raw={...defaultUnifiedConfig(tmpdir(),path.join(tmpdir(),'diagnostic-unit.json')),configPath:path.join(tmpdir(),'diagnostic-unit.json')};
  const diagnostics=new McpDiagnostics(db,raw,'instance-test');diagnostics.registerTool('fs_write');
  const remoteSecret='remote-id-must-not-be-logged';
  let received=0,closed=0,protocol='',options:unknown;
  let previousMessages=0,previousErrors=0,previousCloses=0,forwardedErrors=0;
  const inner:Transport={sessionId:'test-session',async start(){},async send(_message,value){options=value;throw new Error('private transport detail');},async close(){this.onclose?.();},setProtocolVersion(version){protocol=version;}};
  inner.onmessage=()=>{previousMessages++;};inner.onerror=()=>{previousErrors++;};inner.onclose=()=>{previousCloses++;};
  const transport=observeMcpTransport(inner,diagnostics);
  transport.onmessage=()=>{received++;};transport.onclose=()=>{closed++;};
  transport.onerror=()=>{forwardedErrors++;};
  await transport.start();transport.setProtocolVersion?.('version-test');
  assert.equal(protocol,'version-test');assert.equal(transport.sessionId,'test-session');
  inner.onmessage?.({jsonrpc:'2.0',id:remoteSecret,method:'tools/call',params:{name:'fs_write',arguments:{secret:'never-record-me'}}});
  assert.equal(received,1);
  assert.equal(previousMessages,1);inner.onerror?.(new Error('transport-warning'));assert.equal(previousErrors,1);assert.equal(forwardedErrors,1);
  const sendOptions={relatedRequestId:remoteSecret};
  await assert.rejects(transport.send({jsonrpc:'2.0',id:remoteSecret,result:{ok:true}},sendOptions),/private transport detail/);
  assert.equal(options,sendOptions);
  let rows=db.prepare('SELECT * FROM mcp_diagnostics').all();assert.equal(rows[0].stage,'send_failed');
  inner.onmessage?.({jsonrpc:'2.0',id:2,method:'tools/list'});
  await transport.close();assert.equal(closed,1);
  assert.equal(previousCloses,1);assert.equal(previousMessages,2);
  rows=db.prepare('SELECT * FROM mcp_diagnostics').all();assert.equal(rows[1].stage,'transport_closed');
  assert.doesNotMatch(JSON.stringify(rows),/remote-id-must-not-be-logged|never-record-me|private transport detail/);
  db.close();
});

test('disabled or failed diagnostics never turn a successful protocol response into an error',async()=>{
  const config={...defaultUnifiedConfig(tmpdir(),path.join(tmpdir(),'diagnostic-off.json')),configPath:path.join(tmpdir(),'diagnostic-off.json')};
  config.diagnostics.enabled=false;
  const db=new DatabaseSync(':memory:');const disabled=new McpDiagnostics(db,config,'disabled');
  assert.equal(disabled.begin({jsonrpc:'2.0',id:1,method:'tools/list'}),undefined);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='mcp_diagnostics'").get()?.n,0);
  db.close();
  const brokenDb=new DatabaseSync(':memory:');brokenDb.close();config.diagnostics.enabled=true;
  const broken=new McpDiagnostics(brokenDb,config,'broken');
  assert.equal(broken.snapshot().available,false);
  let sent=0;
  const inner:Transport={async start(){},async send(){sent++;},async close(){}};
  const transport=observeMcpTransport(inner,broken);await transport.start();
  inner.onmessage?.({jsonrpc:'2.0',id:1,method:'tools/list'});
  await transport.send({jsonrpc:'2.0',id:1,result:{tools:[]}});assert.equal(sent,1);await transport.close();
});

test('server guidance starts with the authorized text and binary saving workflow',()=>{
  const first=SERVER_INSTRUCTIONS.slice(0,512);
  for(const tool of ['system_status','workspace_list','fs_copy','fs_write','fs_mkdir','fs_read','fs_save_file','fs_save_file_status','fs_stat'])assert.ok(first.includes(tool));
  assert.match(first,/SVG/);assert.match(first,/actual host file reference and source size\/SHA-256/);
  assert.match(first,/Never use sandbox paths as file IDs/);assert.match(first,/expected_sha256=null is create-only/);
  assert.ok(SERVER_INSTRUCTIONS.length<5500);
});

test('execution diagnostics retain actionable fixed codes without arguments or arbitrary failure text',async()=>{
  const db=new DatabaseSync(':memory:');
  const config={...defaultUnifiedConfig(tmpdir(),path.join(tmpdir(),'execution-diagnostics.json')),configPath:path.join(tmpdir(),'execution-diagnostics.json')};
  const diagnostics=new McpDiagnostics(db,config,'synthetic');diagnostics.registerTool('exec_start');
  const inner:Transport={async start(){},async send(){},async close(){}};
  const transport=observeMcpTransport(inner,diagnostics);await transport.start();
  try {
    const codes=['INVALID_EXECUTABLE','EXECUTABLE_NOT_FOUND','EXECUTION_PROFILE_CHANGED','CONCURRENCY_LIMIT','private-unknown-error'];
    for(const [id,code] of codes.entries()){
      inner.onmessage?.({jsonrpc:'2.0',id,method:'tools/call',params:{name:'exec_start',arguments:{args:['private-command-argument']}}});
      await transport.send({jsonrpc:'2.0',id,result:{isError:true,structuredContent:{error:{code,message:'private-failure-text'}}}});
    }
    const rows=db.prepare('SELECT * FROM mcp_diagnostics ORDER BY id').all();
    assert.deepEqual(rows.map(row=>row.error_code),[...codes.slice(0,4),'OTHER_TOOL_ERROR']);
    assert.doesNotMatch(JSON.stringify(rows),/private-command-argument|private-failure-text|private-unknown-error/);
  }finally{await transport.close();db.close();}
});

test('omitted arguments normalization is independent of diagnostics and preserves the original request and transport metadata',async()=>{
  const db=new DatabaseSync(':memory:');
  const config={...defaultUnifiedConfig(tmpdir(),path.join(tmpdir(),'diagnostic-normalize.json')),configPath:path.join(tmpdir(),'diagnostic-normalize.json')};
  config.diagnostics.enabled=false;
  const diagnostics=new McpDiagnostics(db,config,'normalization-test');
  let original:unknown,delivered:any,deliveredExtra:unknown;
  const inner:Transport={async start(){},async send(){},async close(){},onmessage:message=>{original=message;}};
  const wrapper=observeMcpTransport(inner,diagnostics);
  wrapper.onmessage=(message,extra)=>{delivered=message;deliveredExtra=extra;};
  await wrapper.start();
  const params=Object.freeze({name:'system_status',_meta:{progressToken:7},task:{ttl:1000}});
  const request=Object.freeze({jsonrpc:'2.0' as const,id:3,method:'tools/call',params});
  const extra={requestInfo:{headers:{'x-test':'opaque'}}};
  inner.onmessage?.(request,extra);
  assert.equal(original,request);assert.notEqual(delivered,request);
  assert.deepEqual(delivered,{...request,params:{...params,arguments:{}}});
  assert.equal(delivered.params._meta,params._meta);assert.equal(delivered.params.task,params.task);
  assert.equal(deliveredExtra,extra);assert.equal(Object.hasOwn(params,'arguments'),false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='mcp_diagnostics'").get()?.n,0);
  await wrapper.close();db.close();
});

test('late sends cannot overwrite closed observations or remove a newer request with the same ID',async()=>{
  for(const trigger of ['close','duplicate'] as const){
    const db=new DatabaseSync(':memory:');
    const config={...defaultUnifiedConfig(tmpdir(),path.join(tmpdir(),'diagnostic-race.json')),configPath:path.join(tmpdir(),'diagnostic-race.json')};
    const diagnostics=new McpDiagnostics(db,config,'race-instance');
    let release!:()=>void,sends=0;
    const inner:Transport={async start(){},async send(){if(++sends===1)await new Promise<void>(resolve=>{release=resolve;});},async close(){this.onclose?.();}};
    const transport=observeMcpTransport(inner,diagnostics);await transport.start();
    inner.onmessage?.({jsonrpc:'2.0',id:1,method:'tools/list'});
    const first=transport.send({jsonrpc:'2.0',id:1,result:{tools:[]}});
    if(trigger==='close')await transport.close();
    else inner.onmessage?.({jsonrpc:'2.0',id:1,method:'tools/list'});
    release();await first;
    let rows=db.prepare('SELECT outcome,stage FROM mcp_diagnostics ORDER BY id').all();
    assert.equal(rows[0].outcome,'unconfirmed');
    assert.equal(rows[0].stage,trigger==='close'?'transport_closed':'duplicate_request_id');
    if(trigger==='duplicate'){
      assert.equal(rows[1].outcome,'received');
      await transport.send({jsonrpc:'2.0',id:1,result:{tools:[]}});
      rows=db.prepare('SELECT outcome,stage FROM mcp_diagnostics ORDER BY id').all();
      assert.equal(rows[1].outcome,'responded');await transport.close();
    }
    db.close();
  }
});
