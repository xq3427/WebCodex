import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {defaultConfig} from '../src/config.js';
import {App} from '../src/app.js';
import {snapshotFile} from '../src/file-snapshot.js';
import {AppError} from '../src/errors.js';
async function fixture(t:TestContext){
  const parent=await realpath(tmpdir()),base=await mkdtemp(path.join(parent,'webcodex-file-snapshot-')),root=path.join(base,'project');await mkdir(root);
  const configPath=path.join(base,'config.json'),app=new App({...defaultConfig(root,configPath),configPath});
  t.after(async()=>{await app.close();assert.equal(path.dirname(await realpath(base)),parent);assert.ok(path.basename(base).startsWith('webcodex-file-snapshot-'));await rm(base,{recursive:true,force:true});});
  return{app,root};
}
test('file evidence hashes full binary bytes independently of text response limits',async t=>{
  const {app,root}=await fixture(t);app.ctx.config.limits.readMaxBytes=256;
  const bytes=Buffer.alloc(200000,0xff);bytes[0]=0;await writeFile(path.join(root,'asset.bin'),bytes);
  const result=await snapshotFile(app.ctx,{workspace_id:'default',path:'asset.bin',max_bytes:200000});
  assert.deepEqual(result,{path:'asset.bin',exists:true,size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  await assert.rejects(snapshotFile(app.ctx,{workspace_id:'default',path:'asset.bin',max_bytes:199999}),{code:'FILE_TOO_LARGE'});
});
test('file evidence distinguishes an absent final path and an empty file',async t=>{
  const {app,root}=await fixture(t);const input={workspace_id:'default',path:'new.txt',max_bytes:0};
  assert.deepEqual(await snapshotFile(app.ctx,input),{path:'new.txt',exists:false,sha256:null,size_bytes:0});
  await writeFile(path.join(root,'new.txt'),'');const result=await snapshotFile(app.ctx,input);assert.equal(result.exists,true);assert.equal(result.sha256,createHash('sha256').digest('hex'));
  await assert.rejects(snapshotFile(app.ctx,{...input,path:'missing/parent.txt'}),{code:'ENOENT'});
});
test('file evidence rejects protected paths, directories and hardlinks',async t=>{
  const {app,root}=await fixture(t);const input={workspace_id:'default',path:'.codex/auth.json'};
  await assert.rejects(snapshotFile(app.ctx,input),{code:'PATH_DENIED'});await assert.rejects(snapshotFile(app.ctx,{...input,path:'.'}),{code:'PATH_DENIED'});
  await writeFile(path.join(root,'one'),'source');await link(path.join(root,'one'),path.join(root,'two'));
  await assert.rejects(snapshotFile(app.ctx,{...input,path:'two'}),{code:'PATH_DENIED'});
});

test('post-read policy failures report FILE_CHANGED while read-before failures retain their original code',async t=>{
  const {app,root}=await fixture(t);
  const bytes=Buffer.alloc(180000,0x7f);await writeFile(path.join(root,'evidence.bin'),bytes);
  const input={workspace_id:'default',path:'evidence.bin',max_bytes:bytes.length};
  assert.equal((await snapshotFile(app.ctx,input)).sha256,createHash('sha256').update(bytes).digest('hex'));
  const original=app.ctx.paths.resolve.bind(app.ctx.paths);
  for(const code of ['ENOENT','PATH_DENIED','STATE_DEVICE_MISMATCH']){
    let calls=0;
    const postRead=t.mock.method(app.ctx.paths,'resolve',async (...args:Parameters<typeof original>)=>{
      calls++;
      if(calls===2)throw new AppError(code,'Synthetic policy changed after the complete read.');
      return original(...args);
    });
    try{
      await assert.rejects(snapshotFile(app.ctx,input),{code:'FILE_CHANGED'});
      assert.equal(calls,2,'the failure must be injected at the real read final-validation boundary');
    }finally{postRead.mock.restore();}
    const beforeRead=t.mock.method(app.ctx.paths,'resolve',async ()=>{throw new AppError(code,'Synthetic early policy rejection.');});
    try{await assert.rejects(snapshotFile(app.ctx,input),{code});}
    finally{beforeRead.mock.restore();}
  }
  assert.equal((await snapshotFile(app.ctx,input)).sha256,createHash('sha256').update(bytes).digest('hex'));
});
