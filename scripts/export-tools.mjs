import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, writeFile, mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { defaultUnifiedConfig } from '../dist/src/config.js';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.argv.slice(2).some(arg=>arg!=='--check'))throw new Error('Usage: node scripts/export-tools.mjs [--check]');
const check=process.argv.includes('--check');
const client=new Client({name:'webcodex-schema-export',version:'1.0'});
// Schema export must not acquire the running tunnel service's SQLite lease.
const tempRoot=await realpath(os.tmpdir());
const temporary=await mkdtemp(path.join(tempRoot,'webcodex-schema-'));
try {
 const workspace=path.join(temporary,'workspace');
 await mkdir(workspace);
 const configPath=path.join(temporary,'config.json');
 await writeFile(configPath,JSON.stringify(defaultUnifiedConfig(workspace,configPath,{deviceName:'Example device'}))+'\n');
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/src/cli.js'),'serve','--config',configPath],stderr:'inherit'}));
 const result=await client.listTools();
 const content=JSON.stringify({server:client.getServerVersion(),tools:result.tools},null,2)+'\n';
 const target=path.join(root,'docs/tools.json');
 if(check){
   if((await readFile(target,'utf8')).replaceAll('\r\n','\n')!==content)throw new Error('Tool documentation is stale. Build and run npm run export:tools.');
 }else await writeFile(target,content);
 console.log((check?'Verified ':'Exported ')+result.tools.length+' tools in docs/tools.json');
}finally{
 try { await client.close(); }
 finally {
  const actual=await realpath(temporary);
  if(path.dirname(actual)!==tempRoot || !path.basename(actual).startsWith('webcodex-schema-'))throw new Error('Refusing cleanup outside the schema export directory.');
  await rm(actual,{recursive:true,force:true});
 }
}
