import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { initializeIdentity } from './identity.js';
import type { ServiceContext } from './types.js';

interface Cursor { binding:string; path:string; sha256:string; stamp:string; offset:number }
const changed = () => new AppError('FILE_CURSOR_STALE','The file changed or was replaced. Restart fs_read_chunk without a cursor.');
const stamp = (s:BigIntStats) => [s.ino,s.birthtimeNs,s.size,s.mtimeNs,s.ctimeNs].join(':');
const same = (a:BigIntStats,b:BigIntStats) => stamp(a)===stamp(b) && (a.dev===b.dev || process.platform==='win32'&&(a.dev===0n||b.dev===0n));
const boundary = (b:Buffer,end:number) => { while(end>0&&end<b.length&&(b[end]&0xc0)===0x80)end--;return end; };

/** Revalidate and stream the entire bounded source per page; never cache a stale file body. */
export class FileChunkService {
  private readonly key=randomBytes(32);
  constructor(private readonly ctx:ServiceContext) {}
  private encode(value:Cursor) {
    const body=Buffer.from(JSON.stringify(value)).toString('base64url');
    return body+'.'+createHmac('sha256',this.key).update(body).digest('base64url');
  }
  private decode(value:string):Cursor {
    try {
      if(value.length>4096)throw 0;
      const parts=value.split('.');if(parts.length!==2)throw 0;
      const expected=createHmac('sha256',this.key).update(parts[0]).digest(), supplied=Buffer.from(parts[1],'base64url');
      if(supplied.length!==expected.length||!timingSafeEqual(expected,supplied))throw 0;
      const cursor=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')) as Cursor;
      if(!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw 0;
      return cursor;
    } catch { throw new AppError('INVALID_CURSOR','Invalid file cursor or service restarted. Restart fs_read_chunk without a cursor.'); }
  }
  async read(input:{workspace_id:string;path:string;cursor?:string;max_bytes?:number}) {
    const max=input.max_bytes??this.ctx.config.limits.readMaxBytes;
    if(!Number.isSafeInteger(max)||max<256||max>this.ctx.config.limits.readMaxBytes)throw new AppError('INVALID_ARGUMENT','max_bytes must be between 256 and limits.readMaxBytes.');
    const absolute=await this.ctx.paths.resolve(input.workspace_id,input.path);
    const relative=path.relative(this.ctx.paths.get(input.workspace_id).root,absolute).split(path.sep).join('/');
    const binding=initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    const cursor=input.cursor?this.decode(input.cursor):undefined;
    const pathKey=process.platform==='win32'?absolute.toLowerCase():absolute;
    const pathHash=createHash('sha256').update(pathKey).digest('hex');
    if(cursor&&(cursor.binding!==binding||cursor.path!==pathHash))throw new AppError('INVALID_CURSOR','The file cursor belongs to a different path or workspace.');
    const before=await lstat(absolute,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)throw new AppError('PATH_DENIED','Chunk reading requires a regular file without links.');
    const limit=this.ctx.config.limits.fileReadMaxBytes??16777216;
    if(before.size>BigInt(limit))throw new AppError('FILE_TOO_LARGE','File exceeds limits.fileReadMaxBytes.',{size:Number(before.size),limit});
    if(cursor&&cursor.stamp!==stamp(before))throw changed();
    const file=await open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try {
      const initial=await file.stat({bigint:true});
      if(!same(before,initial)||initial.nlink!==1n)throw changed();
      const prefix=Buffer.alloc(3);let prefixRead=0;
      while(prefixRead<Math.min(3,Number(initial.size))){const read=await file.read(prefix,prefixRead,Math.min(3,Number(initial.size))-prefixRead,prefixRead);if(!read.bytesRead)throw changed();prefixRead+=read.bytesRead;}
      let encoding:'utf8'|'utf16le'|'utf16be'='utf8',bomBytes=0;
      if(prefixRead>=2&&prefix[0]===0xff&&prefix[1]===0xfe){encoding='utf16le';bomBytes=2;}
      else if(prefixRead>=2&&prefix[0]===0xfe&&prefix[1]===0xff){encoding='utf16be';bomBytes=2;}
      else if(prefixRead===3&&prefix.equals(Buffer.from([0xef,0xbb,0xbf])))bomBytes=3;
      const decoder=new TextDecoder(encoding==='utf8'?'utf-8':encoding==='utf16le'?'utf-16le':'utf-16be',{fatal:true,ignoreBOM:true});
      const digest=createHash('sha256');const buffer=Buffer.alloc(65536);
      const pieces:Buffer[]=[];let position=0,total=0,returned=0,lf=0,crlf=0,lastCR=false,full=false;
      const offset=cursor?.offset??0;
      const consume=(text:string) => {
        if(/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text))throw new AppError('BINARY_FILE','This file contains binary control characters.');
        lf+=(text.match(/\n/g)??[]).length;crlf+=(text.match(/\r\n/g)??[]).length;
        if(lastCR&&text.startsWith('\n'))crlf++;
        if(text.length)lastCR=text.endsWith('\r');
        const bytes=Buffer.from(text);
        if(!full&&total+bytes.length>offset){
          const start=Math.max(0,offset-total);
          if(start>0&&(bytes[start]&0xc0)===0x80)throw new AppError('INVALID_CURSOR','Cursor does not reference a text boundary.');
          const end=boundary(bytes,Math.min(bytes.length,start+max-returned));
          if(end>start){pieces.push(Buffer.from(bytes.subarray(start,end)));returned+=end-start;}
          if(end<bytes.length||returned===max)full=true;
        }
        total+=bytes.length;
      };
      // Fixed positional reads avoid a growing source turning into an unbounded read.
      while(position<Number(initial.size)){
        const count=Math.min(buffer.length,Number(initial.size)-position);
        const {bytesRead}=await file.read(buffer,0,count,position);if(!bytesRead)throw changed();
        const bytes=buffer.subarray(0,bytesRead);digest.update(bytes);
        try{consume(decoder.decode(bytes.subarray(Math.min(bytesRead,Math.max(0,bomBytes-position))),{stream:true}));}
        catch(error){if(error instanceof AppError)throw error;throw new AppError('UNSUPPORTED_ENCODING','Only valid UTF-8 and BOM-marked UTF-16 text files are supported.');}
        position+=bytesRead;
      }
      try{consume(decoder.decode());}catch(error){if(error instanceof AppError)throw error;throw new AppError('UNSUPPORTED_ENCODING','The file contains incomplete or invalid text encoding.');}
      const sha256=digest.digest('hex');
      if(!same(initial,await file.stat({bigint:true})))throw changed();
      await this.ctx.paths.resolve(input.workspace_id,input.path);
      const latest=await lstat(absolute,{bigint:true});
      if(!same(initial,latest)||latest.nlink!==1n||latest.isSymbolicLink()||initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id)!==binding)throw changed();
      if(cursor&&(cursor.sha256!==sha256||offset>=total))throw changed();
      const end=offset+returned,complete=end===total;
      const next=complete?null:this.encode({binding,path:pathHash,sha256,stamp:stamp(initial),offset:end});
      this.ctx.store.audit('fs_read_chunk',input.workspace_id,{path:relative,offset_bytes:offset,end_bytes:end,sha256});
      return {workspace_id:input.workspace_id,path:relative,sha256,size_bytes:Number(initial.size),format:{encoding,bom:bomBytes>0,newline:lf===0?'none':crlf===lf?'crlf':crlf===0?'lf':'mixed'},content:Buffer.concat(pieces).toString('utf8'),chunk:{offset_bytes:offset,end_bytes:end,total_bytes:total,unit:'decoded_utf8_bytes'},returned_bytes:returned,complete,next_cursor:next};
    } finally {await file.close();}
  }
}
