import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, rename, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { defaultConfig } from '../src/config.js';
import { App } from '../src/app.js';
import { FileChunkService } from '../src/file-chunks.js';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t:TestContext){
  const parent=await realpath(tmpdir());const base=await mkdtemp(path.join(parent,'webcodex-chunks-'));
  const root=path.join(base,'project');await mkdir(root);const configPath=path.join(base,'config.json');
  const config={...defaultConfig(root,configPath),configPath};
  const other=path.join(base,'other');await mkdir(other);config.workspaces.push({id:'other',name:'other',root:other,readOnly:false});
  const app=new App(config);
  t.after(async()=>{await app.close();assert.equal(path.dirname(await realpath(base)),parent);assert.ok(path.basename(base).startsWith('webcodex-chunks-'));await rm(base,{recursive:true,force:true});});
  return {root,other,app,config};
}
async function collect(app:App,file:string,max=65536){
  let cursor:string|undefined;let content='',offset=0;let pages=0;
  do{
    const result=await app.fileChunks.read({workspace_id:'default',path:file,cursor,max_bytes:max});
    assert.equal(result.chunk.offset_bytes,offset);assert.equal(result.returned_bytes,Buffer.byteLength(result.content));
    assert.ok(result.returned_bytes<=max);assert.ok(!result.content.includes('\ufffd'));
    offset=result.chunk.end_bytes;content+=result.content;cursor=result.next_cursor??undefined;
    assert.equal(result.complete,cursor===undefined);assert.ok(++pages<10000);
    if(!cursor)assert.equal(offset,result.chunk.total_bytes);
  }while(cursor);
  return {content,pages};
}
test('large single line streams beyond legacy read bound with complete Chinese and emoji',async t=>{
  const f=await fixture(t);const content='需求中文😀x'.repeat(85000);const bytes=Buffer.from(content);
  assert.ok(bytes.length>1048576);await writeFile(path.join(f.root,'large.txt'),bytes);
  await assert.rejects(f.app.files.read({workspace_id:'default',path:'large.txt'}),{code:'FILE_TOO_LARGE'});
  const first=await f.app.fileChunks.read({workspace_id:'default',path:'large.txt'});assert.equal(first.sha256,sha(bytes));
  const result=await collect(f.app,'large.txt');assert.equal(result.content,content);assert.ok(result.pages>16);
  await assert.rejects(f.app.files.write({workspace_id:'default',path:'large.txt',content:'replacement',expected_sha256:first.sha256,idempotency_key:'large-write'}),{code:'FILE_TOO_LARGE'});
});
test('BOM UTF8 and UTF16 in either byte order round trip with per-response UTF8 budgets',async t=>{
  const f=await fixture(t);const content='文😀\r\n'.repeat(15000)+'尾\n';
  for(const encoding of ['utf8','utf16le','utf16be'] as const){
    let body=Buffer.from(content,encoding==='utf8'?'utf8':'utf16le');if(encoding==='utf16be')body=body.swap16();
    const bytes=Buffer.concat([Buffer.from(encoding==='utf8'?[239,187,191]:encoding==='utf16le'?[255,254]:[254,255]),body]);
    const file=encoding+'.txt';await writeFile(path.join(f.root,file),bytes);
    const first=await f.app.fileChunks.read({workspace_id:'default',path:file,max_bytes:1027});
    assert.deepEqual(first.format,{encoding,bom:true,newline:'mixed'});assert.equal(first.sha256,sha(bytes));
    assert.equal((await collect(f.app,file,4099)).content,content);
  }
});
test('cursor retries are stable, permit new budgets and reject edits, replacement, path and workspace mismatch',async t=>{
  const f=await fixture(t);const text='中文😀'.repeat(300);const file=path.join(f.root,'a.txt');await writeFile(file,text);
  await writeFile(path.join(f.root,'b.txt'),text);await writeFile(path.join(f.other,'a.txt'),text);
  const input={workspace_id:'default',path:'a.txt',max_bytes:256};
  const first=await f.app.fileChunks.read(input);assert.ok(first.next_cursor);
  const continuation={...input,cursor:first.next_cursor!};const second=await f.app.fileChunks.read(continuation);
  assert.deepEqual(await f.app.fileChunks.read(continuation),second);
  assert.equal((await f.app.fileChunks.read({...continuation,max_bytes:513})).chunk.offset_bytes,first.chunk.end_bytes);
  for(const mismatch of [{path:'b.txt'},{workspace_id:'other'},{cursor:first.next_cursor!.slice(0,-3)+'abc'}])await assert.rejects(f.app.fileChunks.read({...continuation,...mismatch}),{code:'INVALID_CURSOR'});
  await assert.rejects(new FileChunkService(f.app.ctx).read(continuation),{code:'INVALID_CURSOR'});
  await writeFile(file,text.replace('中文','不同'));await assert.rejects(f.app.fileChunks.read(continuation),{code:'FILE_CURSOR_STALE'});
  const next=await f.app.fileChunks.read(input);await rename(file,file+'.old');await writeFile(file,text.replace('中文','不同'));
  await assert.rejects(f.app.fileChunks.read({...input,cursor:next.next_cursor!}),{code:'FILE_CURSOR_STALE'});
});
test('full-source validation rejects oversized, invalid trailing encoding, binary and linked files',async t=>{
  const f=await fixture(t);f.config.limits.fileReadMaxBytes=2048;
  await writeFile(path.join(f.root,'large.txt'),'a'.repeat(2049));
  await assert.rejects(f.app.fileChunks.read({workspace_id:'default',path:'large.txt'}),{code:'FILE_TOO_LARGE'});
  for(const [name,bytes,code] of [['invalid',Buffer.concat([Buffer.alloc(1000,65),Buffer.from([0xff])]),'UNSUPPORTED_ENCODING'],['binary',Buffer.concat([Buffer.alloc(1000,65),Buffer.from([0])]),'BINARY_FILE']] as const){
    await writeFile(path.join(f.root,name),bytes);await assert.rejects(f.app.fileChunks.read({workspace_id:'default',path:name,max_bytes:256}),{code});
  }
  await writeFile(path.join(f.root,'a.txt'),'a');await link(path.join(f.root,'a.txt'),path.join(f.root,'linked.txt'));
  await assert.rejects(f.app.fileChunks.read({workspace_id:'default',path:'linked.txt'}),{code:'PATH_DENIED'});
  await assert.rejects(f.app.fileChunks.read({workspace_id:'default',path:'.codex/auth.json'}),{code:'PATH_DENIED'});
  await assert.rejects(f.app.fileChunks.read({workspace_id:'default',path:'a.txt',max_bytes:1}),{code:'INVALID_ARGUMENT'});
});
test('empty and BOM-only files terminate on the first page',async t=>{
  const f=await fixture(t);
  for(const bytes of [Buffer.alloc(0),Buffer.from([255,254]),Buffer.from([239,187,191])]){
    await writeFile(path.join(f.root,'empty.txt'),bytes);const result=await f.app.fileChunks.read({workspace_id:'default',path:'empty.txt'});
    assert.equal(result.content,'');assert.equal(result.complete,true);assert.equal(result.next_cursor,null);assert.equal(result.sha256,sha(bytes));
  }
});
