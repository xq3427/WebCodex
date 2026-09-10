import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig, loadConfig } from '../src/config.js';
import { WorkspacePaths, within } from '../src/paths.js';
import { StateStore } from '../src/store.js';
import { AppError } from '../src/errors.js';

async function fixture() {
  const base=await mkdtemp(path.join(await realpath(tmpdir()),'webcodex-core-'));const root=path.join(base,'workspace');await mkdir(root);
  const configPath=path.join(base,'config.json');const raw=defaultConfig(root,configPath);await writeFile(configPath,JSON.stringify(raw));
  const config=await loadConfig(configPath);return{base,root,config,paths:new WorkspacePaths(config),clean:async()=>{assert.ok(path.basename(base).startsWith('webcodex-core-'));await rm(base,{recursive:true,force:true});}};
}
test('path policy denies escape, Windows namespace, links and protected state',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.root,'hello.txt'),'hello');
    assert.equal(await f.paths.resolve('default','hello.txt'),path.join(f.root,'hello.txt'));
    for(const relative of ['../config.json','C:hello','C:/hello','//server/file','file:ads','.git/config','.env','.webcodex/config.json','CON.txt','bad.','bad /file']){
      await assert.rejects(f.paths.resolve('default',relative),(e:unknown)=>e instanceof AppError && e.code==='PATH_DENIED',relative);
    }
    await assert.rejects(f.paths.resolve('missing','hello.txt'),{code:'WORKSPACE_NOT_FOUND'});
    await assert.rejects(f.paths.resolve('default','missing/child',{write:true,allowMissing:true}),{code:'ENOENT'});
    const outside=path.join(f.base,'outside');await mkdir(outside);await writeFile(path.join(outside,'secret.txt'),'private');
    await symlink(outside,path.join(f.root,'jump'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(f.paths.resolve('default','jump/secret.txt'),{code:'PATH_DENIED'});
    await link(path.join(outside,'secret.txt'),path.join(f.root,'hard.txt'));
    await assert.rejects(f.paths.resolve('default','hard.txt'),{code:'PATH_DENIED'});
    assert.equal(within(f.root,f.root+'-other'),false);
    f.config.workspaces[0].readOnly=true;
    await assert.rejects(f.paths.resolve('default','hello.txt',{write:true}),{code:'READ_ONLY'});
  }finally{await f.clean();}
});
test('idempotency persists, rejects payload reuse, coalesces concurrent calls and protects state ownership',async()=>{
  const f=await fixture();let store=new StateStore(f.config.stateDir);try{
    assert.throws(()=>new StateStore(f.config.stateDir),{code:'STATE_LOCKED'});
    let calls=0;
    const action=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return{answer:42};};
    const [a,b]=await Promise.all([store.idempotent('owner/ws/write','op-1',{a:1,b:2},action),store.idempotent('owner/ws/write','op-1',{b:2,a:1},action)]);
    assert.deepEqual(a,b);assert.equal(calls,1);
    await assert.rejects(store.idempotent('owner/ws/write','op-1',{a:2},action),{code:'IDEMPOTENCY_CONFLICT'});
    store.close();store=new StateStore(f.config.stateDir);
    assert.deepEqual(await store.idempotent('owner/ws/write','op-1',{a:1,b:2},action),a);assert.equal(calls,1);
    store.db.prepare("INSERT INTO operations(scope,op_key,digest,status,created_at) VALUES('scope','unknown','abc','pending','now')").run();
    store.close();store=new StateStore(f.config.stateDir);
    assert.equal((store.db.prepare("SELECT status FROM operations WHERE op_key='unknown'").get() as any).status,'unknown');
  }finally{store.close();await f.clean();}
});
test('config requires unique workspaces and native absolute executable aliases',async()=>{
  const f=await fixture();try{
    const raw=defaultConfig(f.root,f.config.configPath);
    await writeFile(f.config.configPath,'\uFEFF'+JSON.stringify(raw));
    assert.equal((await loadConfig(f.config.configPath)).execution.mode,'disabled');
    await writeFile(f.config.configPath,JSON.stringify({...raw,workspaces:[raw.workspaces[0],raw.workspaces[0]]}));
    await assert.rejects(loadConfig(f.config.configPath),{code:'CONFIG_ERROR'});
    await writeFile(f.config.configPath,JSON.stringify({...raw,execution:{...raw.execution,allowedExecutables:{node:'node'}}}));
    await assert.rejects(loadConfig(f.config.configPath),{code:'CONFIG_ERROR'});
  }finally{await f.clean();}
});
