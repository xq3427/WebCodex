import { spawn } from 'node:child_process';
import { AppError } from './errors.js';
import type { ServiceContext } from './types.js';
import { repositoryForWorkspace } from './worktree-policy.js';
import { assertWorkspaceAvailable } from './workspace-health.js';

export class GitService {
  constructor(private ctx:ServiceContext) {}
  private async run(workspaceId:string,args:string[],allowNoMatches=false):Promise<{output:string;truncated:boolean}> {
    const root = await this.ctx.paths.resolve(workspaceId,'.',{directory:true});
    const workspace = this.ctx.paths.get(workspaceId);
    const repository = repositoryForWorkspace(this.ctx.config, workspace);
    const gitDir = repository.gitDir;
    if(args[0]!=='config') {
      const filters=await this.run(workspaceId,['config','--null','--get-regexp','^filter\\..*\\.(clean|process)$'],true);
      if(filters.truncated || filters.output.length)throw new AppError('GIT_FILTERS_UNSUPPORTED','Repositories with configured clean/process filters (including Git LFS) cannot be inspected because Git could execute host commands.');
    }
    assertWorkspaceAvailable(this.ctx.config, workspace);
    return await new Promise<{output:string;truncated:boolean}>((resolve,reject)=>{
      const env:NodeJS.ProcessEnv={};
      for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP']) if(process.env[key]) env[key]=process.env[key];
      Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_PAGER:'',GIT_LITERAL_PATHSPECS:'1',GIT_NO_LAZY_FETCH:'1',LC_ALL:'C.UTF-8'});
      const proc=spawn(this.ctx.config.gitPath ?? 'git',['--no-pager','--git-dir='+gitDir,'--work-tree='+root,'-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.quotePath=false','-c','status.renames=false','-c','core.hooksPath='+ (process.platform==='win32'?'NUL':'/dev/null'),...args],{cwd:root,env,shell:false,windowsHide:true});
      let chunks:Buffer[]=[];let bytes=0;let truncated=false;let errorText=''; let timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;proc.kill();},15000);
      proc.stdout.on('data',(raw:Buffer)=>{const room=this.ctx.config.limits.readMaxBytes-bytes;if(raw.length>room)truncated=true;if(room>0){const kept=raw.subarray(0,room);chunks.push(kept);bytes+=kept.length;}});
      proc.stderr.on('data',(raw:Buffer)=>{if(errorText.length<2048)errorText+=raw.toString('utf8').slice(0,2048-errorText.length);});
      proc.on('error',()=>{clearTimeout(timer);reject(new AppError('GIT_UNAVAILABLE','Git could not be started. Install Git and check PATH.'));});
      proc.on('close',(code)=>{clearTimeout(timer);if(timedOut)return reject(new AppError('TIMED_OUT','Git inspection exceeded 15 seconds.'));if(code!==0 && !(allowNoMatches&&code===1))return reject(new AppError('GIT_ERROR','Git inspection failed.',{exit_code:code}));try { assertWorkspaceAvailable(this.ctx.config, workspace); repositoryForWorkspace(this.ctx.config, workspace); } catch(error) { reject(error); return; } resolve({output:Buffer.concat(chunks).toString('utf8'),truncated});});
    });
  }
  private async allowed(workspaceId:string,relative:string) { try{await this.ctx.paths.resolve(workspaceId,relative,{allowMissing:true});return true;}catch{return false;} }
  private async repositoryInfo(workspaceId:string) {
    const repository=repositoryForWorkspace(this.ctx.config,this.ctx.paths.get(workspaceId));
    const branch=await this.run(workspaceId,['symbolic-ref','--quiet','--short','HEAD'],true);
    const head=await this.run(workspaceId,['rev-parse','--verify','--quiet','HEAD'],true);
    if(branch.truncated||head.truncated)throw new AppError('GIT_ERROR','Repository identity exceeds the output limit.');
    return {root:repository.root,repository_kind:repository.repositoryKind,branch:branch.output.trim()||null,head:head.output.trim()||null};
  }
  async status(input:{workspace_id:string}) {
    const repository=await this.repositoryInfo(input.workspace_id);
    const data=await this.run(input.workspace_id,['status','--porcelain=v1','-z','--untracked-files=normal','--ignore-submodules=all']);
    const records=data.output.split('\0');records.pop();const entries:Array<{status:string;path:string}>=[];let hidden=0;
    for(const record of records.slice(0,this.ctx.config.limits.listMaxEntries)){const file=record.slice(3);if(await this.allowed(input.workspace_id,file))entries.push({status:record.slice(0,2),path:file});else hidden++;}
    assertWorkspaceAvailable(this.ctx.config, this.ctx.paths.get(input.workspace_id));
    return {workspace_id:input.workspace_id,...repository,entries,output:entries.map(x=>x.status+' '+x.path).join('\n'),truncated:data.truncated||records.length>this.ctx.config.limits.listMaxEntries,hidden_entries:hidden,format:'porcelain-v1-filtered'};
  }
  async diff(input:{workspace_id:string;staged?:boolean}) {
    const repository=await this.repositoryInfo(input.workspace_id);
    const options=['diff','--no-ext-diff','--no-textconv','--no-renames','--ignore-submodules=all',...(input.staged?['--cached']:[])];
    const names=await this.run(input.workspace_id,[...options,'--name-only','-z','--']);
    if(names.truncated)throw new AppError('GIT_DIFF_TOO_LARGE','Changed file list exceeds the output limit. Inspect smaller changes locally.');
    const files=names.output.split('\0').filter(Boolean);const allowed:string[]=[];
    for(const file of files){if(await this.allowed(input.workspace_id,file))allowed.push(file);}
    if(allowed.length>200 || allowed.join(' ').length>20000)throw new AppError('GIT_DIFF_TOO_LARGE','Too many changed paths for one diff. Inspect locally.');
    const data=allowed.length?await this.run(input.workspace_id,[...options,'--',...allowed]):{output:'',truncated:false};
    assertWorkspaceAvailable(this.ctx.config, this.ctx.paths.get(input.workspace_id));
    return {workspace_id:input.workspace_id,...repository,staged:!!input.staged,files:allowed,hidden_files:files.length-allowed.length,...data};
  }
}
