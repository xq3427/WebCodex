import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultUnifiedConfig } from '../src/config.js';
import { parseConfigText, serializeConfig } from '../src/config-format.js';

const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
const legacyKey='synthetic-archived-cli-key-never-print-394718';
const tunnelKey='synthetic-existing-tunnel-key-never-print-589341';
const legacy={enabled:true,apiKey:legacyKey,publicBaseUrl:'https://old-experiment.invalid',port:8766,quickTunnel:{clientPath:'./missing-cloudflared',startupTimeoutMs:60000}};
async function fixture(format:'json'|'toml'='json'){
  const parent=await realpath(tmpdir());const base=await mkdtemp(path.join(parent,'webcodex-panel-cli-'));
  const root=path.join(base,'中文项目 with spaces');await mkdir(root);await writeFile(path.join(root,'marker.txt'),'preserve-local-file');
  const configPath=path.join(base,'config.'+format);
  const raw={...defaultUnifiedConfig(root,configPath),actionsProbe:legacy};
  raw.stateDir=path.join(base,'unused-state');raw.toolsDir=path.join(base,'unused-tools');raw.tunnel.apiKey=tunnelKey;
  let source='';
  return {base,root,configPath,raw,save:async()=>{source=serializeConfig(raw,format);await writeFile(configPath,source);},
    unchanged:async()=>{assert.equal(await readFile(configPath,'utf8'),source);await assert.rejects(access(raw.stateDir),{code:'ENOENT'});await assert.rejects(access(raw.toolsDir),{code:'ENOENT'});assert.equal(await readFile(path.join(root,'marker.txt'),'utf8'),'preserve-local-file');},
    clean:async()=>{const actual=await realpath(base);assert.equal(path.dirname(actual),parent);assert.ok(path.basename(actual).startsWith('webcodex-panel-cli-'));await rm(actual,{recursive:true,force:true});}};
}
function assertPrivate(...outputs:string[]){for(const key of [legacyKey,tunnelKey])assert.ok(!outputs.join('\n').includes(key),'Saved credentials must not be printed.');}
function run(configPath:string,args:string[]){
  const result=spawnSync(process.execPath,[cli,...args,'--config',configPath],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:131072});
  assert.ifError(result.error);assert.equal(result.signal,null);assertPrivate(result.stdout,result.stderr);return result;
}
async function freePort(){const server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();assert.ok(address&&typeof address==='object');await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port;}
async function start(configPath:string){
  const bootstrap="import { pathToFileURL } from 'node:url'; const target=process.argv.splice(1,1)[0]; process.stdin.once('data',()=>{process.stdin.pause();process.emit('SIGINT');process.emit('SIGINT');}); await import(pathToFileURL(target).href);";
  const child=spawn(process.execPath,['--input-type=module','-e',bootstrap,'--',cli,'panel','--config',configPath],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  let timer:ReturnType<typeof setTimeout>;
  try{
    const info=await new Promise<{ok:boolean;url:string;local_only:boolean}>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('The panel CLI did not report startup.')),10000);
      child.stdout.on('data',(bytes:Buffer)=>{stdout+=bytes.toString('utf8');if(stdout.length>131072)return reject(new Error('Panel output exceeded its expected size.'));try{const result=JSON.parse(stdout);if(result?.ok&&result?.url)resolve(result);}catch{}});
      child.stderr.on('data',(bytes:Buffer)=>{stderr+=bytes.toString('utf8');if(stderr.length>131072)child.kill();});
      child.once('error',reject);child.once('exit',()=>reject(new Error('The panel CLI exited before startup.')));
    });
    clearTimeout(timer!);
    return {info,stop:async()=>{
      child.stdin.end('stop');
      const timeout=setTimeout(()=>child.kill(),5000);
      try{const result=await closed;assertPrivate(stdout,stderr);assert.equal(result.code,0,stderr);assert.equal(result.signal,null);assert.equal(stdout.trim().split('"local_only"').length,2,'The launch URL should be printed once.');}
      finally{clearTimeout(timeout);}
    }};
  }catch(error){clearTimeout(timer!);child.kill();await closed;assertPrivate(stdout,stderr);throw error;}
}

test('CLI advertises the local panel and rejects retired Actions startup commands before effects',async()=>{
  const f=await fixture();try{
    await f.save();const help=run(f.configPath,['--help']);assert.equal(help.status,0);assert.match(help.stdout,/panel \[--config PATH\]/);assert.doesNotMatch(help.stdout,/actions-probe|cloudflared|trycloudflare/);
    for(const args of [['actions-probe','enable'],['actions-probe','connect'],['actions-probe','serve'],['actions-probe','schema','--output',path.join(f.base,'forbidden.json')],['panel','--transport','http'],['panel','unexpected']]){
      const result=run(f.configPath,args);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr.trim().split(/\r?\n/).at(-1)!).error.code,'CLI_ERROR');
    }
    await assert.rejects(access(path.join(f.base,'forbidden.json')),{code:'ENOENT'});await f.unchanged();
  }finally{await f.clean();}
});

for(const format of ['json','toml'] as const){
  test(`${format} CLI exports normal panel defaults without legacy experiments and disables only the saved legacy flag`,async()=>{
    const f=await fixture(format);try{
      f.raw.localPanel.port=8989;await f.save();
      const output=path.join(f.base,'fresh.json');const exported=run(f.configPath,['config','export','--output',output]);assert.equal(exported.status,0,exported.stderr);
      const bytes=await readFile(output,'utf8');assertPrivate(bytes);const template=JSON.parse(bytes);assert.deepEqual(template.localPanel,{port:8767});assert.equal('actionsProbe' in template,false);await f.unchanged();
      const disabled=run(f.configPath,['actions-probe','disable']);assert.equal(disabled.status,0,disabled.stderr);
      assert.equal(JSON.parse(disabled.stdout).actionsProbe.active,false);
      assert.deepEqual(parseConfigText(await readFile(f.configPath,'utf8'),format),parseConfigText(serializeConfig({...f.raw,actionsProbe:{...legacy,enabled:false}},format),format));
      await assert.rejects(access(f.raw.stateDir),{code:'ENOENT'});await assert.rejects(access(f.raw.toolsDir),{code:'ENOENT'});
    }finally{await f.clean();}
  });
}

test('panel CLI loads offline workspaces in diagnostic mode without constructing App or StateStore',async()=>{
  const f=await fixture();let running:Awaited<ReturnType<typeof start>>|undefined;
  try{
    f.raw.localPanel.port=await freePort();f.raw.workspaces[0].root=path.join(f.base,'offline-workspace');await f.save();
    running=await start(f.configPath);const url=new URL(running.info.url);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,String(f.raw.localPanel.port));assert.equal(running.info.local_only,true);
    await running.stop();running=undefined;await f.unchanged();
  }finally{if(running)await running.stop();await f.clean();}
});
