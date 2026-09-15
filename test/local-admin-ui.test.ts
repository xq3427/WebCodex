import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { renderLocalAdmin } from '../src/local-admin-ui.js';
import { VERSION } from '../src/version.js';
import { PANEL_ISSUE_MESSAGES } from '../src/panel-validation.js';

type Handler = (event: any) => unknown;
class Element {
  private ownId = ''; private ownText = '';
  children: Element[] = []; disabled = false; hidden = false; readOnly = false; checked = false;
  value = ''; className = ''; type = ''; focused = false; open = false; scrolled = false;
  dataset: Record<string,string> = {}; attributes: Record<string,string> = {};
  listeners = new Map<string,Handler[]>();
  classList = { add: (...names: string[]) => { this.className += ' ' + names.join(' '); } };
  constructor(readonly tagName: string, private readonly ids: Map<string,Element>) {}
  get id() { return this.ownId; } set id(id: string) { this.ownId = id; this.ids.set(id,this); }
  get textContent(): string { return this.ownText + this.children.map(child=>child.textContent).join(''); }
  set textContent(value: string) { this.ownText=String(value); this.children=[]; }
  set innerHTML(_value: string) { throw new Error('Untrusted HTML insertion is forbidden'); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children=nodes; this.ownText=''; }
  setAttribute(key: string,value: string) { this.attributes[key]=String(value); }
  removeAttribute(key: string) { delete this.attributes[key]; }
  getAttribute(key: string) { return this.attributes[key]??null; }
  scrollIntoView() { this.scrolled=true; }
  focus() { this.focused=true; }
  showModal() { this.open=true; }
  close() { this.open=false; }
  addEventListener(event: string,handler: Handler) { this.listeners.set(event,[...this.listeners.get(event)??[],handler]); }
  async trigger(event: string) { if(this.disabled)return;for(const handler of this.listeners.get(event)??[])await handler({target:this,preventDefault(){}}); }
  descendants(): Element[] { return this.children.flatMap(child=>[child,...child.descendants()]); }
  querySelectorAll(selector: string) { return this.descendants().filter(node=>matches(node,selector)); }
}
function matches(node: Element,selector: string) {
  if(selector==='input')return node.tagName==='input';
  if(selector==='input:not([readonly])')return node.tagName==='input'&&!node.readOnly;
  if(selector==='input[id$="-name"]')return node.tagName==='input'&&node.id.endsWith('-name');
  const data=/^\[data-([a-z-]+)\]$/.exec(selector);if(data)return Object.hasOwn(node.dataset,data[1]);
  throw new Error('Unimplemented selector: '+selector);
}
const TOKEN='synthetic-admin-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const KEY='webcodex.local-panel.token.v1';
const SECRET='never-return-this-configured-key';
const REVISION='a'.repeat(64), SAVED='b'.repeat(64);
const valueClone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
function config() { return {ok:true,revision:REVISION,config_path:'D:\\WebCodex\\config.json',format:'json',version:2,
  values:{device:{name:'研究电脑'},workspaces:[{id:'default',name:'研究资料',root:'D:\\研究资料',readOnly:true,enabled:true,onUnavailable:'error',executionProfile:null}],
    execution:{mode:'disabled',maxConcurrent:2,executables:[{alias:'node',command:'node',prefix_arg_count:0}]},
    codexSessions:{enabled:false,home:null},diagnostics:{enabled:true,maxEvents:1000},tunnel:{enabled:false,id:'',proxyUrl:'',clientPath:'auto',clientVersion:'auto'},
    server:{transport:'stdio'},http:{port:8765},localPanel:{port:8767},limits:{writeMaxBytes:1048576},binaryInputs:{chunkMaxBytes:12288,maxSessions:4,maxCacheBytes:1048576,ttlMs:900000}},
  secrets:{tunnelApiKey:true,httpBearerToken:true},read_only:{device_id:'11111111-2222-4333-8444-555555555555',execution_profiles:['restricted']},issues:[]}; }
function reply(body:unknown,status=200){return{status,ok:status>=200&&status<300,json:async()=>valueClone(body)};}
type Fetcher=(url:URL,init:any)=>unknown|Promise<unknown>;
function harness(options:{fetch?:Fetcher;hash?:string;stored?:string;historyThrows?:boolean;storageThrows?:boolean}={}) {
  const html=renderLocalAdmin(),ids=new Map<string,Element>(),staticNodes:Element[]=[];
  for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)){
    const node=new Element(match[1],ids);staticNodes.push(node);for(const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)){
      if(attr[1]==='id')node.id=attr[2];else if(attr[1].startsWith('data-'))node.dataset[attr[1].slice(5)]=attr[2];else node.setAttribute(attr[1],attr[2]);
    }node.hidden=/\bhidden\b/.test(match[2]);node.disabled=/\bdisabled\b/.test(match[2]);
  }
  const script=/<script>\n([\s\S]*?)\n<\/script>/.exec(html)?.[1];assert.ok(script);
  const storage=new Map(options.stored?[[KEY,options.stored]]:[]),sequence:string[]=[],requests:Array<{url:URL;init:any}>=[],timers:Function[]=[];
  const location={origin:'http://127.0.0.1:18767',pathname:'/',search:'',hash:options.hash??'#token='+TOKEN};
  let current:any=config();let runtime:any={ok:true,state:'stopped',managed:false,connected:false,active_jobs:0,restart_required:false};
  const merge=(target:any,patch:any)=>{for(const [key,value]of Object.entries(patch)){if(value&&typeof value==='object'&&!Array.isArray(value))merge(target[key]??={},value);else target[key]=value;}return target;};
  const defaultFetch:Fetcher=(url,init)=>{
    if(url.pathname==='/api/config')return reply(current);
    if(url.pathname==='/api/runtime'){if(init.method==='POST'){const body=JSON.parse(init.body);runtime={...runtime,state:body.action==='stop'?'stopped':'starting',managed:true};return reply({ok:true,action:body.action,status:runtime});}return reply(runtime);}
    if(url.pathname==='/api/config/validate')return reply({ok:true,valid:true,revision:current.revision,restart_required:true});
    if(url.pathname==='/api/access-check')return reply({ok:true,full_access_ready:false,execution:{status:'disabled',command_policy:'allowlist'},workspaces:[{workspace_id:'default',name:'研究资料',status:'read-only',error_code:'READ_ONLY'}]});
    if(url.pathname==='/api/config/save'){const body=JSON.parse(init.body);current={...current,values:merge(valueClone(current.values),body.patch),revision:SAVED};if(body.secrets)for(const [key,value]of Object.entries(body.secrets))current.secrets[key]=Boolean(value);return reply({...current,saved_revision:SAVED,readback_verified:true,changed_again:false,restart_required:true});}
    throw new Error('Unexpected route '+url.pathname);
  };
  const all=()=>[...new Set(staticNodes.flatMap(node=>[node,...node.descendants()]))];
  vm.runInNewContext(script,{
    document:{getElementById:(id:string)=>{assert.ok(ids.has(id),id);return ids.get(id);},createElement:(tag:string)=>new Element(tag,ids),createElementNS:(_namespace:string,tag:string)=>new Element(tag,ids),querySelectorAll:(selector:string)=>all().filter(node=>matches(node,selector)),visibilityState:'visible'},
    window:{addEventListener(){},scrollTo(){}},location,
    history:{replaceState(){if(options.historyThrows)throw new Error(SECRET);sequence.push('clear-hash');location.hash='';}},
    sessionStorage:{getItem:(key:string)=>{if(options.storageThrows)throw new Error(SECRET);return storage.get(key)??null;},setItem:(key:string,value:string)=>{if(options.storageThrows)throw new Error(SECRET);storage.set(key,value);},removeItem:(key:string)=>storage.delete(key)},
    fetch:async(url:string,init:any)=>{sequence.push('fetch');const target=new URL(url);requests.push({url:target,init});await Promise.resolve();return options.fetch?options.fetch(target,init):defaultFetch(target,init);},
    URL,URLSearchParams,AbortController,crypto:{randomUUID:()=> '12345678-1234-4123-8123-123456789abc'},
    setTimeout:(fn:Function)=>{timers.push(fn);return timers.length;},clearTimeout(){},setInterval:(fn:Function)=>{timers.push(fn);return timers.length;},
  },{timeout:3000});
  const get=(id:string)=>{assert.ok(ids.has(id),id);return ids.get(id)!;};
  const labeled=(label:string)=>{const node=all().find(node=>node.attributes['aria-label']===label);assert.ok(node,label);return node;};
  const field=(path:string)=>get('field-'+path.replace(/[^a-zA-Z0-9_-]/g,'-'));
  const settle=async()=>{for(let i=0;i<16;i++)await new Promise(resolve=>setImmediate(resolve));};
  return {html,get,field,labeled,requests,storage,sequence,location,defaultFetch,settle,setRuntime:(next:any)=>{runtime={...runtime,...next};},setCurrent:(next:any)=>{current=next;},allText:()=>all().map(node=>node.textContent+node.value).join('\n'),post:(route:string)=>requests.filter(r=>r.url.pathname===route&&r.init.method==='POST').map(r=>JSON.parse(r.init.body))};
}

test('admin UI is deterministic, script-valid, self contained and uses no unsafe markup sinks',()=>{
  const html=renderLocalAdmin();assert.equal(html,renderLocalAdmin());assert.ok(html.includes(VERSION));
  assert.match(html,/\.switch-track\{pointer-events:none;/,'decorative switch track must not intercept clicks on the actual checkbox');
  assert.doesNotMatch(html,/<script[^>]+src=|<link[^>]+href=|<iframe|<img|\bonclick=|\bstyle=|innerHTML|insertAdjacentHTML|localStorage|XMLHttpRequest|WebSocket/);
  const script=/<script>\n([\s\S]*?)\n<\/script>/.exec(html)?.[1];assert.ok(script);assert.doesNotThrow(()=>new vm.Script(script));
  assert.equal((html.match(/<script>/g)??[]).length,1);assert.equal((html.match(/<style>/g)??[]).length,1);
});

test('admin removes fragment credentials before requests and sends only local authenticated requests',async()=>{
  const h=harness();await h.settle();assert.equal(h.sequence[0],'clear-hash');assert.equal(h.location.hash,'');assert.equal(h.storage.get(KEY),TOKEN);
  assert.deepEqual(h.requests.map(r=>r.url.pathname),['/api/config','/api/runtime']);
  for(const {url,init}of h.requests){assert.equal(url.origin,'http://127.0.0.1:18767');assert.equal(url.href.includes(TOKEN),false);assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.mode,'same-origin');assert.equal(init.headers.Authorization,'Bearer '+TOKEN);}
  assert.equal(h.allText().includes(TOKEN),false);assert.equal(h.field('device.name').value,'研究电脑');
});

test('admin refuses missing/malformed credentials and never exposes fetch failures',async()=>{
  const missing=harness({hash:''});await missing.settle();assert.equal(missing.requests.length,0);
  const malformed=harness({hash:'#token=invalid%0Avalue'});await malformed.settle();assert.equal(malformed.requests.length,0);assert.equal(malformed.location.hash,'');
  const notCleared=harness({historyThrows:true});await notCleared.settle();assert.equal(notCleared.requests.length,0);assert.equal(notCleared.allText().includes(SECRET),false);
  const withoutStorage=harness({storageThrows:true});await withoutStorage.settle();assert.equal(withoutStorage.requests.length,2);
  const failed=harness({fetch:()=>{throw new Error(SECRET);}});await failed.settle();assert.equal(failed.allText().includes(SECRET),false);
});

test('editing creates a minimal draft patch; validation does not save or restart',async()=>{
  const h=harness();await h.settle();h.field('device.name').value='修改后设备';await h.field('device.name').trigger('input');assert.equal(h.post('/api/config/save').length,0);
  await h.get('validate').trigger('click');assert.deepEqual(h.post('/api/config/validate'),[{expected_revision:REVISION,patch:{device:{name:'修改后设备'}}}]);assert.equal(h.post('/api/runtime').length,0);assert.equal(h.get('save').disabled,false);
  await h.get('save').trigger('click');assert.deepEqual(h.post('/api/config/save'),[{expected_revision:REVISION,patch:{device:{name:'修改后设备'}}}]);assert.equal(h.field('device.name').value,'修改后设备');assert.equal(h.get('save').disabled,true);
});

test('refresh preserves all dirty draft and write-only key input without persisting secrets',async()=>{
  const h=harness();await h.settle();h.field('device.name').value='尚未保存';await h.field('device.name').trigger('input');h.get('secret-tunnelApiKey').value='replacement-key';await h.get('secret-tunnelApiKey').trigger('input');
  const configGets=h.requests.filter(r=>r.url.pathname==='/api/config').length;await h.get('refresh').trigger('click');assert.equal(h.field('device.name').value,'尚未保存');assert.equal(h.get('secret-tunnelApiKey').value,'replacement-key');assert.equal(h.requests.filter(r=>r.url.pathname==='/api/config').length,configGets);
  await h.get('save').trigger('click');assert.equal(h.get('secret-tunnelApiKey').value,'');const written=h.post('/api/config/save')[0];assert.equal(written.secrets.tunnelApiKey,'replacement-key');assert.equal(Object.hasOwn(written.secrets,'httpBearerToken'),false);assert.deepEqual([...h.storage.keys()],[KEY]);assert.equal([...h.storage.values()].includes('replacement-key'),false);
});

test('clearing a saved secret requires a concrete confirmation and submits null only for that key',async()=>{
  const h=harness();await h.settle();const clear=h.get('tunnel-secret').descendants().find(node=>node.tagName==='button'&&node.textContent==='清除');assert.ok(clear);await clear.trigger('click');
  const pending=h.get('save').trigger('click');await h.settle();assert.match(h.get('dialog-changes').textContent,/清除已保存的 OpenAI API key/);assert.equal(h.post('/api/config/save').length,0);await h.get('dialog-confirm').trigger('click');await pending;
  assert.deepEqual(h.post('/api/config/save')[0],{expected_revision:REVISION,patch:{},secrets:{tunnelApiKey:null}});assert.equal(h.get('secret-tunnelApiKey').value,'');assert.deepEqual([...h.storage.keys()],[KEY]);
});

test('one execution switch enables every command without exposing program or workspace-profile editors',async()=>{
  const h=harness();await h.settle();assert.doesNotMatch(h.html,/executable-list|renderExecutables|添加允许的程序|执行配置</);assert.doesNotMatch(h.allText(),/程序别名|添加允许的程序/);
  const toggle=h.labeled('本机命令执行');toggle.checked=true;await toggle.trigger('change');await h.get('validate').trigger('click');
  assert.deepEqual(h.post('/api/config/validate')[0].patch.execution,{mode:'trusted-host',commandPolicy:'all'});
  assert.equal(h.post('/api/config/save').length,0);assert.equal(h.post('/api/runtime').length,0);
});

test('legacy restricted execution remains accurately labelled and can adopt the unified switch or turn off',async()=>{
  for(const adopt of [true,false]){let h!:ReturnType<typeof harness>;h=harness({fetch:(url,init)=>{if(url.pathname==='/api/config'){const c=config();c.values.execution.mode='trusted-host';return reply(c);}return h.defaultFetch(url,init);}});await h.settle();
    assert.equal(h.get('stat-execution').textContent,'旧版受限');assert.match(h.get('feature-execution').textContent,/旧版受限执行/);assert.equal(h.post('/api/config/save').length,0);
    if(adopt){const button=h.get('feature-execution').descendants().find(node=>node.tagName==='button'&&node.textContent==='改为统一开启');assert.ok(button);await button.trigger('click');}
    else{const toggle=h.labeled('本机命令执行');toggle.checked=false;await toggle.trigger('change');}
    await h.get('validate').trigger('click');assert.deepEqual(h.post('/api/config/validate')[0].patch.execution,adopt?{commandPolicy:'all'}:{mode:'disabled'});
    if(adopt){const pending=h.get('save').trigger('click');await h.settle();assert.match(h.get('dialog-changes').textContent,/无需逐个放行程序/);assert.match(h.get('dialog-changes').textContent,/当前账户权限/);assert.match(h.get('dialog-changes').textContent,/不是系统沙箱/);await h.get('dialog-cancel').trigger('click');await pending;}
  }
});

test('new workspaces have explicit IDs and writable default; nullable inputs submit null',async()=>{
  const h=harness();await h.settle();await h.get('add-workspace').trigger('click');h.field('workspaces.1.root').value='E:\\论文';await h.field('workspaces.1.root').trigger('input');h.field('tunnel.clientSha256').value='';await h.field('tunnel.clientSha256').trigger('input');await h.get('validate').trigger('click');
  const draft=h.post('/api/config/validate')[0].patch;assert.match(draft.workspaces[1].id,/^ws_[a-f0-9]{32}$/);assert.equal(draft.workspaces[1].readOnly,false);assert.equal(draft.workspaces[0].executionProfile,null);assert.equal(draft.tunnel.clientSha256,null);
});

test('permission expansion waits for a concrete confirmation before saving',async()=>{
  const h=harness();await h.settle();const toggle=h.labeled('本机命令执行');toggle.checked=true;await toggle.trigger('change');const pending=h.get('save').trigger('click');await h.settle();assert.equal(h.get('confirm-dialog').open,true);assert.match(h.get('dialog-changes').textContent,/开启本机命令执行/);assert.equal(h.post('/api/config/save').length,0);
  await h.get('dialog-cancel').trigger('click');await pending;assert.equal(h.post('/api/config/save').length,0);
  const accepted=h.get('save').trigger('click');await h.settle();await h.get('dialog-confirm').trigger('click');await accepted;assert.deepEqual(h.post('/api/config/save')[0].patch.execution,{mode:'trusted-host',commandPolicy:'all'});
});

test('one-click full access opens every enabled workspace and all native commands, then renders real probe errors',async()=>{
  const h=harness();await h.settle();await h.get('enable-full-access').trigger('click');
  assert.equal(h.field('workspaces.0.readOnly').checked,false);assert.equal(h.labeled('本机命令执行').checked,true);assert.equal(h.get('full-access-status').textContent,'已配置');
  const pending=h.get('save').trigger('click');await h.settle();assert.match(h.get('dialog-changes').textContent,/开放.*写入权限/);assert.match(h.get('dialog-changes').textContent,/无需逐个放行程序/);await h.get('dialog-confirm').trigger('click');await pending;
  const saved=h.post('/api/config/save')[0].patch;assert.equal(saved.workspaces[0].readOnly,false);assert.equal(saved.workspaces[0].root,'D:\\研究资料');assert.deepEqual(saved.execution,{mode:'trusted-host',commandPolicy:'all'});
  await h.get('access-check').trigger('click');assert.deepEqual(h.post('/api/access-check'),[{}]);assert.match(h.get('access-results').textContent,/配置为只读.*READ_ONLY/);
});

test('save and restart uses the exact committed revision and does not re-read an unrelated revision',async()=>{
  const h=harness();await h.settle();h.field('device.name').value='重启测试';await h.field('device.name').trigger('input');const pending=h.get('save-restart').trigger('click');await h.settle();await h.get('dialog-confirm').trigger('click');await pending;
  assert.deepEqual(h.post('/api/runtime'),[{action:'restart',expected_revision:SAVED}]);assert.equal(h.requests.filter(r=>r.url.pathname==='/api/config').length,1);assert.match(h.get('runtime-heading').textContent,/正在启动/);
});

test('save receipt with concurrent edit or unverified readback never triggers an automatic restart',async()=>{
  for(const anomaly of [{changed_again:true},{readback_verified:false},{readback_error:'CONFIG_PATH_DENIED'}]){let h!:ReturnType<typeof harness>;h=harness({fetch:async(url,init)=>{const r=await h.defaultFetch(url,init)as any;if(url.pathname==='/api/config/save')return reply({...await r.json(),...anomaly});return r;}});await h.settle();h.field('device.name').value='并发保存';await h.field('device.name').trigger('input');const pending=h.get('save-restart').trigger('click');await h.settle();await h.get('dialog-confirm').trigger('click');await pending;assert.equal(h.post('/api/config/save').length,1);assert.equal(h.post('/api/runtime').length,0);assert.match(h.get('notice-text').textContent,/已成功保存.*不会自动重启/);}
});

test('external launchers cannot be stopped/restarted; owned stop omits a stale config revision',async()=>{
  const h=harness();await h.settle();h.setRuntime({state:'external',managed:false,connected:false,needs_one_time_handoff:true});await h.get('connection-refresh').trigger('click');assert.equal(h.get('runtime-start').disabled,true);assert.equal(h.get('runtime-restart').disabled,true);assert.equal(h.get('runtime-stop').disabled,true);assert.match(h.get('runtime-detail').textContent,/Ctrl\+C/);
  h.setRuntime({state:'running',managed:true,connected:false,needs_one_time_handoff:false});await h.get('connection-refresh').trigger('click');assert.match(h.get('runtime-heading').textContent,/等待连接/);const pending=h.get('runtime-stop').trigger('click');await h.settle();await h.get('dialog-confirm').trigger('click');await pending;assert.deepEqual(h.post('/api/runtime'),[{action:'stop'}]);
});

test('runtime refresh distinguishes local HTTP readiness from a connected stdio tunnel across transport changes',async()=>{
  const h=harness();await h.settle();h.setRuntime({state:'running',managed:true,connected:true,transport:'stdio'});await h.get('connection-refresh').trigger('click');
  assert.equal(h.get('runtime-heading').textContent,'服务已连接');assert.match(h.get('runtime-subtitle').textContent,/可回到 ChatGPT 调用 WebCodex/);
  h.field('server.transport').value='http';await h.field('server.transport').trigger('input');await h.get('connection-refresh').trigger('click');
  assert.equal(h.get('runtime-heading').textContent,'服务已连接','an unsaved transport draft must not relabel the running service');
  h.setRuntime({transport:'http'});await h.get('connection-refresh').trigger('click');
  for(const id of ['runtime-heading','runtime-state','connection-runtime'])assert.equal(h.get(id).textContent,'本机 HTTP 已就绪');
  assert.equal(h.get('runtime-subtitle').textContent,'本机 HTTP 接口已启动，尚未验证 ChatGPT 接入。');assert.doesNotMatch(h.get('runtime-subtitle').textContent,/已观测到有效连接|可回到 ChatGPT 调用/);
  h.setRuntime({transport:'stdio'});await h.get('connection-refresh').trigger('click');
  assert.equal(h.get('runtime-heading').textContent,'服务已连接');assert.match(h.get('runtime-subtitle').textContent,/可回到 ChatGPT 调用 WebCodex/);assert.equal(h.post('/api/runtime').length,0);
});

test('config values remain text, unknown response fields and server error messages never render',async()=>{
  const malicious='<img src=x onerror=alert(1)>';let h!:ReturnType<typeof harness>;h=harness({fetch:(url,init)=>{if(url.pathname==='/api/config'){const c=config();c.values.device.name=malicious;return reply({...c,apiKey:SECRET});}if(url.pathname==='/api/config/validate')return reply({ok:false,error:{code:'PANEL_CONFIG_INVALID',message:SECRET,details:{fields:['patch.limits']}}},400);return h.defaultFetch(url,init);}});await h.settle();assert.equal(h.get('summary-device').textContent,malicious);assert.equal(h.get('summary-device').children.length,0);await h.get('validate').trigger('click');assert.equal(h.allText().includes(SECRET),false);assert.match(h.get('validation-list').textContent,/高级设置 → 文件读写限制/);assert.equal(h.get('breadcrumb').textContent,'高级设置');assert.equal(h.field('limits.readMaxBytes').focused,true);
});

test('legacy top-level fields locate the actual input and clear its accessible error when edited',async()=>{
  let h!:ReturnType<typeof harness>;h=harness({fetch:(url,init)=>url.pathname==='/api/config/validate'?reply({ok:false,error:{code:'PANEL_CONFIG_INVALID',message:SECRET,fields:['patch.tunnel.clientSha256']}},400):h.defaultFetch(url,init)});await h.settle();
  await h.get('validate').trigger('click');const input=h.field('tunnel.clientSha256');assert.equal(h.get('breadcrumb').textContent,'连接设置');assert.equal(input.focused,true);assert.equal(input.scrolled,true);assert.equal(input.attributes['aria-invalid'],'true');assert.match(input.attributes['aria-describedby'],/-error/);assert.equal(h.get(input.id+'-error').hidden,false);assert.match(h.get('validation-list').textContent,/客户端 SHA-256/);assert.equal(h.allText().includes(SECRET),false);
  input.value='a'.repeat(64);await input.trigger('input');assert.equal(input.attributes['aria-invalid'],undefined);assert.equal(h.get(input.id+'-error').hidden,true);assert.equal(h.get('validation-summary').hidden,true);assert.equal(h.post('/api/config/save').length,0);assert.equal(h.post('/api/runtime').length,0);
});

test('precise validation issues mark every field and clickable summary changes tabs without discarding drafts',async()=>{
  let h!:ReturnType<typeof harness>;h=harness({fetch:(url,init)=>url.pathname==='/api/config/validate'?reply({ok:false,error:{code:'PANEL_CONFIG_INVALID',message:SECRET,issues:[{field:'workspaces.0.root',message:PANEL_ISSUE_MESSAGES.missingDirectory},{field:'tunnel.clientSha256',message:PANEL_ISSUE_MESSAGES.sha256}]}},400):h.defaultFetch(url,init)});await h.settle();
  h.field('device.name').value='尚未保存的设备';await h.field('device.name').trigger('input');await h.get('validate').trigger('click');assert.equal(h.get('breadcrumb').textContent,'工作区');assert.equal(h.field('workspaces.0.root').focused,true);assert.equal(h.field('workspaces.0.root').attributes['aria-invalid'],'true');assert.equal(h.field('tunnel.clientSha256').attributes['aria-invalid'],'true');assert.match(h.get('validation-list').textContent,/第 1 个工作区 · 本机目录/);assert.match(h.get('validation-list').textContent,/目录不存在/);
  const links=h.get('validation-list').descendants().filter(node=>node.tagName==='button');assert.equal(links.length,2);await links[1].trigger('click');assert.equal(h.get('breadcrumb').textContent,'连接设置');assert.equal(h.field('tunnel.clientSha256').focused,true);assert.equal(h.field('device.name').value,'尚未保存的设备');assert.equal(h.post('/api/config/save').length,0);
  h.field('tunnel.clientSha256').value='a'.repeat(64);await h.field('tunnel.clientSha256').trigger('input');assert.equal(h.field('tunnel.clientSha256').attributes['aria-invalid'],undefined);assert.equal(h.field('workspaces.0.root').attributes['aria-invalid'],'true');assert.equal(h.get('validation-list').descendants().filter(node=>node.tagName==='button').length,1);
});

test('invalid numeric and secret settings stop save-and-restart and preserve both drafts and write-only input',async()=>{
  let h!:ReturnType<typeof harness>;h=harness({fetch:(url,init)=>url.pathname==='/api/config/validate'?reply({ok:false,error:{code:'PANEL_CONFIG_INVALID',issues:[{field:'limits.writeMaxBytes',message:'请输入 1024–4194304 之间的整数。'},{field:'secrets.tunnelApiKey',message:PANEL_ISSUE_MESSAGES.secret}]}},400):h.defaultFetch(url,init)});await h.settle();
  h.field('limits.writeMaxBytes').value='2';await h.field('limits.writeMaxBytes').trigger('input');h.get('secret-tunnelApiKey').value='bad key';await h.get('secret-tunnelApiKey').trigger('input');const pending=h.get('save-restart').trigger('click');await h.settle();await h.get('dialog-confirm').trigger('click');await pending;
  assert.equal(h.post('/api/config/save').length,0);assert.equal(h.post('/api/runtime').length,0);assert.equal(h.field('limits.writeMaxBytes').value,'2');assert.equal(h.get('secret-tunnelApiKey').value,'bad key');assert.equal(h.get('secret-tunnelApiKey').attributes['aria-invalid'],'true');assert.equal(h.get('breadcrumb').textContent,'高级设置');assert.match(h.get('validation-list').textContent,/1024–4194304/);assert.match(h.get('validation-list').textContent,/OpenAI API key/);assert.equal(h.field('limits.writeMaxBytes').disabled,false);assert.equal(h.field('limits.writeMaxBytes').focused,true);
  const secretLink=h.get('validation-list').descendants().find(node=>node.tagName==='button'&&node.textContent.includes('OpenAI API key'));assert.ok(secretLink);await secretLink.trigger('click');assert.equal(h.get('breadcrumb').textContent,'连接设置');assert.equal(h.get('secret-tunnelApiKey').focused,true);h.get('secret-tunnelApiKey').value='replacement-key';await h.get('secret-tunnelApiKey').trigger('input');assert.equal(h.get('secret-tunnelApiKey').attributes['aria-invalid'],undefined);assert.equal(h.field('limits.writeMaxBytes').attributes['aria-invalid'],'true');
});

test('unknown validation paths and unapproved issue messages never expose values or claim invisible markings',async()=>{
  let h!:ReturnType<typeof harness>;let unknownOnly=false;h=harness({fetch:(url,init)=>url.pathname==='/api/config/validate'?reply({ok:false,error:{code:'PANEL_CONFIG_INVALID',message:SECRET,issues:unknownOnly?[{field:'unknown.'+SECRET,message:SECRET}]:[{field:'tunnel.clientSha256',message:SECRET},{field:'unknown.'+SECRET,message:SECRET}]}},400):h.defaultFetch(url,init)});await h.settle();await h.get('validate').trigger('click');assert.equal(h.allText().includes(SECRET),false);assert.match(h.get('validation-list').textContent,/格式、类型和允许值/);assert.equal(h.get('validation-list').descendants().filter(node=>node.tagName==='button').length,1);
  unknownOnly=true;await h.get('validate').trigger('click');assert.equal(h.allText().includes(SECRET),false);assert.equal(h.get('validation-summary').hidden,true);assert.match(h.get('notice-text').textContent,/服务未提供可定位的字段/);assert.doesNotMatch(h.get('notice-text').textContent,/标出/);
});

test('save and restart validates unchanged config and does not restart an invalid saved baseline',async()=>{
  let h!:ReturnType<typeof harness>;h=harness({fetch:(url,init)=>url.pathname==='/api/config/validate'?reply({ok:false,error:{code:'PANEL_CONFIG_INVALID',fields:['patch.http.port']}},400):h.defaultFetch(url,init)});await h.settle();const pending=h.get('save-restart').trigger('click');await h.settle();await h.get('dialog-confirm').trigger('click');await pending;
  assert.deepEqual(h.post('/api/config/validate'),[{expected_revision:REVISION,patch:{}}]);assert.equal(h.post('/api/config/save').length,0);assert.equal(h.post('/api/runtime').length,0);assert.equal(h.field('http.port').attributes['aria-invalid'],'true');
});
