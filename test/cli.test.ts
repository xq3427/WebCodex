import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpath, access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig } from '../src/config.js';

const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
async function fixture() {
  const base=await mkdtemp(path.join(await realpath(tmpdir()),'webcodex-cli-'));
  const root=path.join(base,'project');await mkdir(root);
  const configPath=path.join(base,'config.json');
  const config=defaultConfig(root,configPath);
  return{base,root,configPath,config,clean:async()=>{
    assert.ok(path.basename(base).startsWith('webcodex-cli-'));
    await rm(base,{recursive:true,force:true});
  }};
}
function doctor(configPath:string) {
  const result=spawnSync(process.execPath,[cli,'doctor','--config',configPath],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.ifError(result.error);
  assert.equal(result.signal,null,result.stderr);
  return{exitCode:result.status,data:JSON.parse(result.stdout),stderr:result.stderr};
}
async function installedRg():Promise<string> {
  const pathKey=Object.keys(process.env).find(key=>key.toLowerCase()==='path');
  const executable=process.platform==='win32'?'rg.exe':'rg';
  for(const directory of (process.env[pathKey??'PATH']??'').split(path.delimiter)){
    if(!directory)continue;
    const candidate=path.resolve(directory.replace(/^"|"$/g,''),executable);
    try{await access(candidate,constants.X_OK);return candidate;}catch{}
  }
  throw new Error('CLI integration tests require an installed ripgrep executable on PATH.');
}
test('doctor reports failure and repair instructions for an unavailable configured ripgrep',async()=>{
  const f=await fixture();try{
    f.config.rgPath=path.join(f.base,'missing-tools','rg.exe');
    await writeFile(f.configPath,JSON.stringify(f.config));
    const result=doctor(f.configPath);
    assert.equal(result.exitCode,1,result.stderr);
    assert.equal(result.data.ok,false);
    assert.equal(result.data.rg.available,false);
    assert.equal(result.data.rg.configured_path,f.config.rgPath);
    assert.match(result.data.rg.remediation,/rgPath/);
    assert.match(result.data.rg.remediation,/absolute path.*installed rg\.exe/);
    assert.equal(result.data.config,f.configPath);
  }finally{await f.clean();}
});
test('doctor succeeds with an installed ripgrep configured by absolute path',async()=>{
  const f=await fixture();try{
    f.config.rgPath=await installedRg();
    await writeFile(f.configPath,JSON.stringify(f.config));
    const result=doctor(f.configPath);
    assert.equal(result.exitCode,0,result.stderr);
    assert.equal(result.data.ok,true);
    assert.equal(result.data.git.available,true);
    assert.equal(result.data.rg.available,true);
    assert.equal(result.data.rg.configured_path,f.config.rgPath);
    assert.match(result.data.rg.version,/^ripgrep /);
    assert.equal(result.data.rg.remediation,undefined);
  }finally{await f.clean();}
});
