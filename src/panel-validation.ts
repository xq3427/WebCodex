import type { ZodIssue } from 'zod';
import { AppError } from './errors.js';

/** This vocabulary is also used by the browser: no parser text, keys or submitted values are echoed. */
export const PANEL_ISSUE_MESSAGES = {
  invalid: '请检查此项的格式、类型和允许值。',
  unsupported: '包含页面不支持编辑的设置；请重新加载页面后再修改。',
  revision: '配置版本已失效，请重新加载当前配置后再保存。',
  boolean: '请选择开启或关闭。',
  name: '请输入 1–120 个字符的名称，不能包含换行或控制字符。',
  path: '请输入有效路径；支持 ${configDir}、${userHome} 和 ${nodePath}，不能包含换行或未知变量。',
  native: '请指定本机程序路径，不能使用 .cmd 或 .bat 脚本。',
  id: '标识只能包含英文字母、数字、下划线和短横线，长度为 1–64 个字符。',
  workspaceCount: '请保留 1–32 个工作区。',
  duplicateId: '工作区标识重复，请为此工作区使用不同的标识。',
  duplicateRoot: '目录与另一个工作区重复，请删除重复项或选择其他目录。',
  nestedPermissions: '此目录与另一个工作区嵌套，读写权限必须一致；不同权限请使用互不包含的目录。',
  profile: '此执行配置不存在，请选择已有配置或清空此项。',
  duplicateAlias: '程序别名重复，请修改或删除重复项。',
  missingDirectory: '目录不存在，请填写已存在的目录，或停用这个已有工作区。',
  deniedDirectory: '目录不可访问，请检查本机访问权限。',
  linkedDirectory: '请选择真实目录，不能使用文件、符号链接或目录联接。',
  protectedDirectory: '此目录属于受保护的配置、状态、仓库元数据或 Codex 目录，请选择其他目录。',
  worktree: '此关联工作树需要先在本机注册或修复注册信息。',
  directory: '目录校验失败，请检查是否存在、可访问且未使用链接。',
  secret: '密钥不能包含空格、换行或不可见字符，最多 4096 个字符。',
  tunnelId: '请输入以 tunnel_ 开头的隧道 ID，后面只能包含英文字母、数字、下划线或短横线。',
  tunnelKey: '开启隧道时必须保存 API key；请填写密钥或关闭隧道。',
  proxy: '代理只能是 HTTP(S) 地址和端口，不能包含账号、密码、路径、查询参数或片段。',
  clientVersion: '客户端版本必须为 auto 或 v数字.数字.数字，例如 v1.2.3。',
  sha256: 'SHA-256 必须为 64 位十六进制字符；使用自动客户端时可留空。',
  requiredSha256: '指定客户端路径时必须填写对应文件的 64 位 SHA-256。',
  httpToken: '使用 HTTP 服务时需要至少 32 个字符的访问令牌，请填写后再保存。',
  codexHome: '开启 Codex 会话读取时必须填写已存在的 Codex 目录。',
  timeout: '默认超时不能大于最大超时，请调整这两项设置。',
  wait: '默认等待时间不能大于最大等待时间，请调整这两项设置。',
  stdin: '单次输入字节数不能大于累计输入字节数。',
  projectBytes: '单文件上下文字节数不能大于上下文总字节数。',
} as const;

const sections: Record<string, readonly string[]> = {
  device:['name'], execution:['mode','commandPolicy','executables','maxConcurrent','defaultTimeoutMs','maxTimeoutMs','maxOutputBytes','defaultWaitMs','maxWaitMs','stdinMaxBytes','stdinMaxTotalBytes','stdinWriteTimeoutMs'],
  codexSessions:['enabled','home','maxWindowsPerRequest','maxRecordBytes'],diagnostics:['enabled','maxEvents'],
  tunnel:['enabled','id','proxyUrl','clientPath','clientVersion','clientSha256'],server:['transport'],http:['port'],localPanel:['port'],
  limits:['readMaxBytes','fileReadMaxBytes','fileTransferMaxBytes','fileWidgetUploadMaxBytes','fileWidgetTicketTtlMs','fileWidgetCacheMaxBytes','fileWidgetChunkMaxBytes','binaryWriteMaxBytes','inlineBinaryWriteMaxBytes','writeMaxBytes','searchMaxResults','listMaxEntries'],
  binaryInputs:['chunkMaxBytes','maxSessions','maxCacheBytes','ttlMs'],fileImports:['maxAttempts','downloadTimeoutMs'],fileBatches:['maxFiles','maxTotalBytes','binaryMaxTotalBytes'],
  tasks:['maxTasksPerWorkspace','maxRevisionsPerTask','maxTrackedFiles','maxSnapshotBytes'],projectContext:['maxDepth','maxFileBytes','maxTotalBytes'],fileWidget:['mode','compact','closeAfterSend'],
  secrets:['tunnelApiKey','httpBearerToken'],
};
const roots = ['patch','expected_revision','nodePath','gitPath','rgPath','toolsDir','workspaces','secrets'];
export const PANEL_FIELD_RANGES: Record<string, readonly [number,number]> = {
  'execution.maxConcurrent':[1,8],'execution.defaultTimeoutMs':[100,86400000],'execution.maxTimeoutMs':[100,86400000],'execution.maxOutputBytes':[1024,52428800],'execution.defaultWaitMs':[0,20000],'execution.maxWaitMs':[1,20000],'execution.stdinMaxBytes':[1,1048576],'execution.stdinMaxTotalBytes':[1,16777216],'execution.stdinWriteTimeoutMs':[100,20000],
  'http.port':[1024,65535],'localPanel.port':[1024,65535],'diagnostics.maxEvents':[20,10000],'codexSessions.maxWindowsPerRequest':[1,8],'codexSessions.maxRecordBytes':[65536,1048576],
  'limits.readMaxBytes':[256,1048576],'limits.fileReadMaxBytes':[1024,134217728],'limits.fileTransferMaxBytes':[1,7340032],'limits.fileWidgetUploadMaxBytes':[1,536870912],'limits.fileWidgetTicketTtlMs':[1000,1800000],'limits.fileWidgetCacheMaxBytes':[1,268435456],'limits.fileWidgetChunkMaxBytes':[4096,262144],'limits.binaryWriteMaxBytes':[1024,134217728],'limits.inlineBinaryWriteMaxBytes':[1024,1048576],'limits.writeMaxBytes':[1024,4194304],'limits.searchMaxResults':[1,1000],'limits.listMaxEntries':[1,1000],
  'binaryInputs.chunkMaxBytes':[1024,262144],'binaryInputs.maxSessions':[1,16],'binaryInputs.maxCacheBytes':[1024,536870912],'binaryInputs.ttlMs':[1000,3600000],'fileImports.maxAttempts':[1,10],'fileImports.downloadTimeoutMs':[1000,300000],
  'fileBatches.maxFiles':[1,100],'fileBatches.maxTotalBytes':[1024,33554432],'fileBatches.binaryMaxTotalBytes':[1024,536870912],
  'tasks.maxTasksPerWorkspace':[1,10000],'tasks.maxRevisionsPerTask':[1,10000],'tasks.maxTrackedFiles':[1,100],'tasks.maxSnapshotBytes':[1024,134217728],
  'projectContext.maxDepth':[1,128],'projectContext.maxFileBytes':[1024,1048576],'projectContext.maxTotalBytes':[1024,4194304],
};
const ranges=PANEL_FIELD_RANGES;
const rangeMessage = (bounds: readonly [number,number]) => `请输入 ${bounds[0]}–${bounds[1]} 之间的整数。`;
export const PANEL_SAFE_ISSUE_MESSAGES: readonly string[] = [...Object.values(PANEL_ISSUE_MESSAGES), ...new Set(Object.values(ranges).map(rangeMessage))];
const messageSet = new Set(PANEL_SAFE_ISSUE_MESSAGES);
export type PanelIssue = { field:string; message:string };
export function isPanelField(field: string): boolean {
  if (roots.includes(field) || Object.hasOwn(sections,field)) return true;
  const parts=field.split('.');
  if (parts.length===2 && Object.hasOwn(sections,parts[0]) && sections[parts[0]].includes(parts[1])) return true;
  if (parts[0]==='workspaces' && /^(?:[0-9]|[12][0-9]|3[01])$/.test(parts[1]??'')) return parts.length===2 || parts.length===3 && ['id','root','name','readOnly','enabled','onUnavailable','executionProfile'].includes(parts[2]);
  return parts[0]==='execution' && parts[1]==='executables' && /^(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(parts[2]??'') && (parts.length===3 || parts.length===4 && ['alias','command','prefix_arg_count'].includes(parts[3]));
}
export function safePanelDetails(input: unknown): { issues:PanelIssue[]; fields:string[] } | undefined {
  if (!input || typeof input!=='object') return;
  const details=input as {issues?:unknown;fields?:unknown};
  const issues = Array.isArray(details.issues) ? details.issues.filter((entry): entry is PanelIssue => Boolean(entry) && typeof entry==='object' && typeof entry.field==='string' && isPanelField(entry.field) && typeof entry.message==='string' && messageSet.has(entry.message)).slice(0,24).map(({field,message})=>({field,message})) : [];
  const fields = [...new Set([...issues.map(issue=>issue.field),...(Array.isArray(details.fields)?details.fields.filter((field):field is string=>typeof field==='string'&&isPanelField(field)):[])])].slice(0,24);
  return fields.length ? {issues,fields} : undefined;
}
export function panelInvalid(issues: PanelIssue[], code='PANEL_CONFIG_INVALID'): AppError {
  return new AppError(code,'配置校验未通过，请修改列出的设置后再保存。',safePanelDetails({issues}));
}
export function panelFieldIssue(field:string, message:keyof typeof PANEL_ISSUE_MESSAGES): PanelIssue { return {field,message:PANEL_ISSUE_MESSAGES[message]}; }
function issueField(parts: (string|number)[]):string {
  if (parts[0]==='patch') parts=parts.slice(1);
  if (parts[0]==='tunnel' && parts[1]==='apiKey') return 'secrets.tunnelApiKey';
  if (parts[0]==='http' && parts[1]==='bearerToken') return 'secrets.httpBearerToken';
  while(parts.length) { const candidate=parts.join('.'); if(isPanelField(candidate))return candidate; parts=parts.slice(0,-1); }
  return 'patch';
}
export function panelSchemaIssues(issues: ZodIssue[]): PanelIssue[] {
  const result:PanelIssue[]=[];
  for(const issue of issues) {
    if(issue.code==='invalid_union') { result.push(...panelSchemaIssues(issue.unionErrors.flatMap(error=>error.issues))); continue; }
    const field=issueField(issue.path);
    let message:string=PANEL_ISSUE_MESSAGES.invalid;
    if(issue.code==='unrecognized_keys')message=PANEL_ISSUE_MESSAGES.unsupported;
    else if(ranges[field])message=rangeMessage(ranges[field]);
    else if(field==='expected_revision')message=PANEL_ISSUE_MESSAGES.revision;
    else if(field.startsWith('secrets.'))message=PANEL_ISSUE_MESSAGES.secret;
    else if(field==='tunnel.clientSha256')message=PANEL_ISSUE_MESSAGES.sha256;
    else if(field==='tunnel.clientVersion')message=PANEL_ISSUE_MESSAGES.clientVersion;
    else if(field==='tunnel.proxyUrl')message=PANEL_ISSUE_MESSAGES.proxy;
    else if(field==='tunnel.id')message=PANEL_ISSUE_MESSAGES.tunnelId;
    else if(field==='workspaces')message=PANEL_ISSUE_MESSAGES.workspaceCount;
    else if(/\.(?:id|alias|executionProfile)$/.test(field))message=PANEL_ISSUE_MESSAGES.id;
    else if(/\.name$/.test(field))message=PANEL_ISSUE_MESSAGES.name;
    else if(/(?:Path|Dir)$|\.(?:root|home|command)$/.test(field))message=PANEL_ISSUE_MESSAGES.path;
    else if(/\.(?:enabled|readOnly|compact|closeAfterSend)$/.test(field))message=PANEL_ISSUE_MESSAGES.boolean;
    result.push({field,message});
  }
  return [...new Map(result.map(issue=>[issue.field,issue])).values()].slice(0,24);
}
