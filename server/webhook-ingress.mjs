// Development tunnel origin. Only this server is exposed; never point a tunnel at Eupova.
import http from 'node:http';
import {fileURLToPath} from 'node:url';
export const sandboxPath='/api/webhooks/peer/sandbox';
export function createWebhookIngress({upstreamPort=4319,limit=120,concurrency=16,now=Date.now,bodyTimeoutMs=5000,upstreamTimeoutMs=10000}={}){
 if(!Number.isInteger(upstreamPort)||upstreamPort<1||upstreamPort>65535)throw Error('Invalid loopback port.');
 let windowAt=now(),requests=0,active=0;
 const server=http.createServer({maxHeaderSize:8192},(req,res)=>{
  const reply=(code,data={accepted:false})=>{if(res.writableEnded||res.destroyed)return;res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close',...(code===429?{'Retry-After':'60'}:{})});res.end(JSON.stringify(data));};
  // Compare the raw path: no query, encoded path, alternate environment or URL normalisation.
  if(req.url!==sandboxPath)return reply(404);
  if(req.method!=='POST')return reply(405);
  if(now()-windowAt>=60000){windowAt=now();requests=0;}
  if(++requests>limit||active>=concurrency)return reply(429);
  if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type']??'')||req.headers['content-encoding'])return reply(415);
  const length=req.headers['content-length'];
  if(length&&(!/^\d+$/.test(length)||Number(length)>262144))return reply(413);
  const headers={'content-type':'application/json'};
  for(const name of ['x-webhook-id','x-webhook-timestamp','x-webhook-signature']){
   const value=req.headers[name];if(typeof value!=='string'||value.length>256)return reply(401);headers[name]=value;
  }
  active++;let released=false,upstream,finished=false;
  const release=()=>{if(!released){released=true;active--;}};
  res.once('close',()=>{clearTimeout(timer);upstream?.destroy();release();});
  res.once('finish',release);
  const timer=setTimeout(()=>{finished=true;reply(408);},bodyTimeoutMs);timer.unref();
  const chunks=[];let size=0;
  req.on('data',chunk=>{if(finished)return;size+=chunk.length;if(size>262144){finished=true;clearTimeout(timer);reply(413);return;}chunks.push(chunk);});
  req.on('error',()=>{finished=true;clearTimeout(timer);reply(400);});
  req.on('end',()=>{
   clearTimeout(timer);if(finished)return;finished=true;
   // Preserve bytes for HMAC; reconstruct only the fixed signature header allowlist.
   const raw=Buffer.concat(chunks);headers['content-length']=String(raw.length);
   upstream=http.request({hostname:'127.0.0.1',port:upstreamPort,path:sandboxPath,method:'POST',headers},response=>{
    // Never relay cookies, redirects, application state, upstream headers or error bodies.
    response.resume();const code=response.statusCode;
    reply(code===202?202:[400,401,403,409,413,415,429,503].includes(code)?code:502,{accepted:code===202});
   });
   const deadline=setTimeout(()=>upstream.destroy(Error('timeout')),upstreamTimeoutMs);deadline.unref();
   upstream.once('close',()=>clearTimeout(deadline));
   upstream.on('error',()=>reply(503));upstream.end(raw);
  });
 });
 server.headersTimeout=5000;server.requestTimeout=15000;server.keepAliveTimeout=1000;server.maxConnections=32;
 return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url))createWebhookIngress().listen(4321,'127.0.0.1',()=>console.log('Sandbox webhook ingress on 127.0.0.1:4321; all other routes denied.'));
