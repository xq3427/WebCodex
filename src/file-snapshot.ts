import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { initializeIdentity } from './identity.js';
import type { ServiceContext } from './types.js';

export interface FileSnapshot { path:string; sha256:string|null; size_bytes:number; exists:boolean }
const same=(a:BigIntStats,b:BigIntStats)=>a.ino===b.ino&&a.birthtimeNs===b.birthtimeNs&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.size===b.size&&
  (a.dev===b.dev||process.platform==='win32'&&(a.dev===0n||b.dev===0n));
const changed=()=>new AppError('FILE_CHANGED','The selected file changed while its snapshot was being captured.');

/** Bounded raw-byte evidence for a selected file, including an explicitly absent final path. */
export async function snapshotFile(ctx:ServiceContext,input:{workspace_id:string;path:string;max_bytes?:number}):Promise<FileSnapshot>{
  const fileLimit=ctx.config.limits.fileReadMaxBytes??16777216;
  const limit=input.max_bytes??fileLimit;
  if(!Number.isSafeInteger(limit)||limit<0)throw new AppError('INVALID_ARGUMENT','Snapshot byte budget must be a nonnegative integer.');
  const bound=Math.min(fileLimit,limit);
  const absolute=await ctx.paths.resolve(input.workspace_id,input.path,{allowMissing:true});
  const binding=initializeIdentity(ctx).workspaceIdentity(input.workspace_id);
  const relative=path.relative(ctx.paths.get(input.workspace_id).root,absolute).split(path.sep).join('/');
  let before:BigIntStats;
  try{before=await lstat(absolute,{bigint:true});}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    await ctx.paths.resolve(input.workspace_id,input.path,{allowMissing:true});
    initializeIdentity(ctx).workspaceIdentity(input.workspace_id);
    try{await lstat(absolute);throw changed();}catch(second){if((second as NodeJS.ErrnoException).code!=='ENOENT')throw second;}
    return {path:relative,sha256:null,size_bytes:0,exists:false};
  }
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)throw new AppError('PATH_DENIED','Snapshots require a regular file without links.');
  if(before.size>BigInt(bound))throw new AppError('FILE_TOO_LARGE','Selected file exceeds the remaining snapshot budget.',{size_bytes:Number(before.size),limit:bound});
  const handle=await open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const initial=await handle.stat({bigint:true});if(!same(before,initial)||initial.nlink!==1n)throw changed();
    const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let offset=0;
    while(offset<Number(initial.size)){
      const result=await handle.read(buffer,0,Math.min(buffer.length,Number(initial.size)-offset),offset);
      if(!result.bytesRead)throw changed();hash.update(buffer.subarray(0,result.bytesRead));offset+=result.bytesRead;
    }
    // The full selected byte budget has already been spent. Do not forward a
    // post-read ENOENT/PATH_DENIED as though it failed before file IO: freshness
    // callers use those early errors to decide whether a remaining budget is reusable.
    try{
      if(!same(initial,await handle.stat({bigint:true})))throw changed();
      await ctx.paths.resolve(input.workspace_id,input.path);
      const current=await lstat(absolute,{bigint:true});
      if(!same(initial,current)||current.isSymbolicLink()||current.nlink!==1n||initializeIdentity(ctx).workspaceIdentity(input.workspace_id)!==binding)throw changed();
    }catch{throw changed();}
    return {path:relative,sha256:hash.digest('hex'),size_bytes:offset,exists:true};
  }finally{await handle.close();}
}
