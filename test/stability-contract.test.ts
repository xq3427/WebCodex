import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '../src/app.js';
import { defaultUnifiedConfig, validateConfig } from '../src/config.js';
import { createMcpServer } from '../src/server.js';
import { FILE_ROUTES } from '../src/file-routing.js';
import { SERVER_INSTRUCTIONS } from '../src/server-instructions.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp } from '../src/http.js';

async function fixture(t: TestContext) {
  const parent=await realpath(tmpdir()), base=await mkdtemp(path.join(parent,'webcodex-stability-'));
  const root=path.join(base,'workspace');await mkdir(root);
  const configPath=path.join(base,'config.json'), raw=defaultUnifiedConfig(root,configPath);
  const config=await validateConfig(raw,configPath),app=new App(config);
  const server=createMcpServer(app),client=new Client({name:'stability-contract',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  t.after(async()=>{await client.close();await server.close();await app.close();const actual=await realpath(base);assert.equal(path.dirname(actual),parent);assert.ok(path.basename(actual).startsWith('webcodex-stability-'));await rm(actual,{recursive:true,force:true});});
  const call=async(name:string,args:Record<string,unknown>)=>(await client.callTool({name,arguments:args})).structuredContent as any;
  return {raw,configPath,app,root,client,call};
}

test('all normal file entry points consistently route PDF text and expose guarded operation status',async t=>{
  const f=await fixture(t),tools=(await f.client.listTools()).tools;
  for(const name of ['fs_list','fs_read_file','fs_open_file','file_widget_probe','document_open']){
    const description=tools.find(tool=>tool.name===name)!.description!;
    assert.ok(description.includes(FILE_ROUTES.pdf),name);
    assert.doesNotMatch(description,/For normal (?:local document|PDF\/Office) reading use ChatGPT native attachments/);
  }
  assert.ok(SERVER_INSTRUCTIONS.includes(FILE_ROUTES.pdf));assert.ok(SERVER_INSTRUCTIONS.length<5500);
  const statusTool=tools.find(tool=>tool.name==='operation_status')!;
  assert.equal(statusTool.annotations?.readOnlyHint,true);
  for(const required of ['tool','idempotency_key','workspace_id','expected_device_id'])assert.ok(statusTool.inputSchema.required?.includes(required));
  const args={workspace_id:'default',tool:'fs_write',idempotency_key:'save-text',expected_device_id:f.app.identity.deviceId};
  const saved=await f.call('fs_write',{workspace_id:'default',path:'中文.txt',content:'first',expected_sha256:null,idempotency_key:args.idempotency_key,expected_device_id:args.expected_device_id});
  assert.equal(saved.ok,true);
  await writeFile(path.join(f.root,'中文.txt'),'external edit');
  const status=await f.call('operation_status',args);
  assert.equal(status.ok,true);assert.equal(status.data.stage,'done');
  assert.equal(status.data.receipt.sha256,saved.data.sha256);
  assert.notEqual(status.data.current_observation.sha256,saved.data.sha256);
  assert.equal(await readFile(path.join(f.root,'中文.txt'),'utf8'),'external edit');
  assert.equal((await f.call('operation_status',{...args,expected_device_id:randomUUID()})).error.code,'DEVICE_MISMATCH');
  assert.equal((await f.call('operation_status',{...args,workspace_id:'unknown'})).error.code,'WORKSPACE_NOT_FOUND');
});

test('unified configuration accepts bounded import policy and binary budgets while preserving old defaults',async t=>{
  const f=await fixture(t);
  const old:any={...f.raw,fileBatches:{maxFiles:20,maxTotalBytes:4194304}};delete old.fileImports;
  const compatible=await validateConfig(old,f.configPath);
  assert.equal(compatible.fileImports,undefined);assert.equal(compatible.fileBatches?.binaryMaxTotalBytes,undefined);
  const custom=await validateConfig({...f.raw,fileImports:{maxAttempts:2,downloadTimeoutMs:120000},fileBatches:{maxFiles:20,maxTotalBytes:4194304,binaryMaxTotalBytes:268435456}},f.configPath);
  assert.equal(custom.fileImports?.maxAttempts,2);assert.equal(custom.fileBatches?.binaryMaxTotalBytes,268435456);
  for(const value of [{maxAttempts:0},{maxAttempts:11},{downloadTimeoutMs:999},{downloadTimeoutMs:300001},{unexpected:true}]){
    await assert.rejects(validateConfig({...f.raw,fileImports:value},f.configPath),{code:'CONFIG_ERROR'});
  }
  await assert.rejects(validateConfig({...f.raw,fileBatches:{...f.raw.fileBatches,binaryMaxTotalBytes:536870913}},f.configPath),{code:'CONFIG_ERROR'});
  const binary=await validateConfig({...f.raw,limits:{...f.raw.limits,inlineBinaryWriteMaxBytes:262144},binaryInputs:{chunkMaxBytes:12288,maxSessions:4,maxCacheBytes:1048576,ttlMs:900000}},f.configPath);
  assert.equal(binary.binaryInputs?.chunkMaxBytes,12288);assert.equal(binary.limits.inlineBinaryWriteMaxBytes,262144);
  const defaults=await validateConfig({...f.raw,binaryInputs:{}},f.configPath);
  assert.equal(defaults.binaryInputs?.chunkMaxBytes,65536);assert.equal(defaults.binaryInputs?.maxCacheBytes,67108864);
  const largest=await validateConfig({...f.raw,binaryInputs:{chunkMaxBytes:262144,maxCacheBytes:536870912}},f.configPath);
  assert.equal(largest.binaryInputs?.chunkMaxBytes,262144);assert.equal(largest.binaryInputs?.maxCacheBytes,536870912);
  for(const settings of [{chunkMaxBytes:1023},{chunkMaxBytes:262145},{maxSessions:17},{maxCacheBytes:1023},{maxCacheBytes:536870913},{ttlMs:3600001},{unknown:true}])await assert.rejects(validateConfig({...f.raw,binaryInputs:settings},f.configPath),{code:'CONFIG_ERROR'});
  await assert.rejects(validateConfig({...f.raw,limits:{...f.raw.limits,inlineBinaryWriteMaxBytes:1048577}},f.configPath),{code:'CONFIG_ERROR'});
});

test('HTTP accepts authorized original binary bytes independently of the lower text write budget',async t=>{
  const f=await fixture(t);f.app.config.limits.writeMaxBytes=1024;
  const token=randomUUID()+randomUUID(),http=await startHttp(f.app,{token,port:0});
  const client=new Client({name:'binary-http-budget',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    const bytes=Buffer.alloc(100000,0x82),sha=createHash('sha256').update(bytes).digest('hex');
    const result:any=await client.callTool({name:'fs_write_binary',arguments:{workspace_id:'default',path:'http-original.bin',content_base64:bytes.toString('base64'),content_sha256:sha,size_bytes:bytes.length,expected_sha256:null,idempotency_key:'http-binary',expected_device_id:f.app.identity.deviceId}});
    assert.equal(result.isError,undefined);assert.equal(result.structuredContent.data.verified,true);
    assert.deepEqual(await readFile(path.join(f.root,'http-original.bin')),bytes);
  } finally {await client.close();await http.close();}
});
