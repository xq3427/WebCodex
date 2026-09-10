import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import type { App } from './app.js';

export async function startHttp(app:App,options:{token:string;port?:number}) {
  if(options.token.length<32)throw new Error('Local HTTP token must have at least 32 characters.');
  let port=options.port??app.config.http.port;let inFlight=0;
  const http=createServer(async(req,res)=>{
    const send=(status:number,error:string)=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error}));}};
    const validHosts=new Set(['127.0.0.1:'+port,'localhost:'+port]);
    if(!validHosts.has(req.headers.host??'') || req.headers.origin!==undefined){send(403,'Invalid host or browser origin.');return;}
    if(req.url==='/healthz' && req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,service:'webcodex-mcp'}));return;}
    if(req.url!=='/mcp'){send(404,'Not found.');return;}
    const auth=req.headers.authorization??'';
    const expected=Buffer.from('Bearer '+options.token);
    const actual=Buffer.from(auth);
    if(actual.length!==expected.length || !timingSafeEqual(actual,expected)){send(401,'Local HTTP authentication required.');return;}
    if(req.method!=='POST'){res.setHeader('Allow','POST');send(405,'Stateless transport accepts POST only.');return;}
    if(!(req.headers['content-type']??'').toLowerCase().startsWith('application/json')){send(415,'Content-Type must be application/json.');return;}
    if(inFlight>=16){send(429,'Too many active requests.');return;}
    inFlight++;
    let server:ReturnType<typeof createMcpServer>|undefined;
    try {
      const limit=Math.min(25165824,app.config.limits.writeMaxBytes*6+65536);
      const declared=Number(req.headers['content-length']??0);
      if(declared>limit){send(413,'Request too large.');req.resume();return;}
      const body=await readBody(req,limit);
      if(body===null){send(413,'Request too large.');return;}
      let parsed:unknown;try{parsed=JSON.parse(body);}catch{send(400,'Invalid JSON.');return;}
      server=createMcpServer(app);
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      await server.connect(transport);
      await transport.handleRequest(req,res,parsed);
    } catch(error) {if((error as Error).message==='BODY_TIMEOUT')send(408,'Request body timed out.');else send(500,'MCP request failed.');}
    finally {inFlight--;await server?.close();}
  });
  http.requestTimeout=30000;http.headersTimeout=10000;http.keepAliveTimeout=5000;
  await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(port,'127.0.0.1',()=>{http.removeListener('error',reject);resolve();});});
  port=(http.address() as {port:number}).port;
  return {port,url:'http://127.0.0.1:'+port+'/mcp',close:()=>new Promise<void>((resolve,reject)=>{http.close(err=>err?reject(err):resolve());http.closeIdleConnections();})};
}
async function readBody(req:IncomingMessage,limit:number):Promise<string|null> {
  return await new Promise((resolve,reject)=>{
    let bytes=0;const chunks:Buffer[]=[];let finished=false;
    const complete=(value:string|null,error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);req.removeListener('data',onData);req.removeListener('end',onEnd);req.removeListener('error',onError);if(error)reject(error);else resolve(value);};
    const onData=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>limit){complete(null);req.resume();}else chunks.push(chunk);};
    const onEnd=()=>complete(Buffer.concat(chunks).toString('utf8'));
    const onError=(error:Error)=>complete(null,error);
    const timer=setTimeout(()=>{complete(null,new Error('BODY_TIMEOUT'));req.resume();},15000);
    req.on('data',onData);req.once('end',onEnd);req.once('error',onError);
  });
}
