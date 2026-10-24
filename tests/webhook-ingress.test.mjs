import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createWebhookIngress,sandboxPath} from '../server/webhook-ingress.mjs';
const headers={'content-type':'application/json','x-webhook-id':'delivery','x-webhook-timestamp':'1792835000','x-webhook-signature':'a'.repeat(64)};
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
test('ingress only forwards exact sandbox POST, unchanged bytes and permitted headers',async()=>{
 let seen=[];
 const upstream=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);seen.push({url:req.url,headers:req.headers,raw:Buffer.concat(chunks).toString()});res.writeHead(202,{'Set-Cookie':'private=secret','Location':'/private'});res.end('private upstream data');});
 await listen(upstream);const ingress=createWebhookIngress({upstreamPort:upstream.address().port});const base=await listen(ingress);
 try{
  for(const path of ['/','/.env','/api/state','/api/checkouts','/api/webhooks/peer/live',sandboxPath+'?x=1',sandboxPath+'/', '/api/webhooks/peer/%73andbox'])assert.equal((await fetch(base+path,{method:'POST',headers,body:'{}'})).status,404);
  assert.equal((await fetch(base+sandboxPath)).status,405);assert.equal(seen.length,0);
  const raw='{ "hello": "£ test",\n "order": null }';
  const res=await fetch(base+sandboxPath,{method:'POST',headers:{...headers,Cookie:'private=session',Origin:'https://other.example','X-Forwarded-Host':'evil.example'},body:raw});
  assert.equal(res.status,202);assert.deepEqual(await res.json(),{accepted:true});assert.equal(res.headers.get('set-cookie'),null);assert.equal(res.headers.get('location'),null);
  assert.equal(seen[0].raw,raw);assert.equal(seen[0].url,sandboxPath);assert.equal(seen[0].headers.host,`127.0.0.1:${upstream.address().port}`);assert.equal(seen[0].headers.cookie,undefined);assert.equal(seen[0].headers.origin,undefined);assert.equal(seen[0].headers['x-forwarded-host'],undefined);assert.equal(seen[0].headers['x-webhook-signature'],headers['x-webhook-signature']);
 }finally{await close(ingress);await close(upstream);}
});
test('ingress rejects unsigned, encoded, oversized and excessive requests before forwarding',async()=>{
 let calls=0,clock=0;const upstream=http.createServer((req,res)=>{calls++;res.writeHead(202).end();});await listen(upstream);
 const ingress=createWebhookIngress({upstreamPort:upstream.address().port,limit:5,now:()=>clock});const base=await listen(ingress);
 try{
  const post=(body='{}',h=headers)=>fetch(base+sandboxPath,{method:'POST',headers:h,body});
  assert.equal((await post('{}',{'content-type':'application/json'})).status,401);
  assert.equal((await post('{}',{...headers,'content-encoding':'gzip'})).status,415);
  assert.equal((await post('x'.repeat(262145))).status,413);
  assert.equal((await post()).status,202);assert.equal((await post()).status,202);assert.equal((await post()).status,429);assert.equal(calls,2);
  clock=60001;assert.equal((await post()).status,202);
 }finally{await close(ingress);await close(upstream);}
});
test('upstream errors and redirects never acknowledge successful receipt',async()=>{
 let status=302;const upstream=http.createServer((req,res)=>{res.writeHead(status,{'Location':'https://example.com','Set-Cookie':'secret'}).end('private error');});await listen(upstream);
 const ingress=createWebhookIngress({upstreamPort:upstream.address().port});const base=await listen(ingress);
 try{for(const [code,expected] of [[302,502],[500,502],[401,401],[503,503]]){status=code;const res=await fetch(base+sandboxPath,{method:'POST',headers,body:'{}'});assert.equal(res.status,expected);assert.deepEqual(await res.json(),{accepted:false});}}finally{await close(ingress);await close(upstream);}
});
test('chunked oversized requests are bounded even without Content-Length',async()=>{
 const ingress=createWebhookIngress();await listen(ingress);
 try{const code=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:ingress.address().port,path:sandboxPath,method:'POST',headers:{...headers,'transfer-encoding':'chunked'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.write('x'.repeat(262144));req.end('x');});assert.equal(code,413);}finally{await close(ingress);}
});
test('slow upstream times out without success and concurrency is bounded',async()=>{
 const upstream=http.createServer(()=>{});await listen(upstream);
 const ingress=createWebhookIngress({upstreamPort:upstream.address().port,concurrency:1,upstreamTimeoutMs:80});const base=await listen(ingress);
 try{
  const pending=fetch(base+sandboxPath,{method:'POST',headers,body:'{}'});
  await once(upstream,'request');
  assert.equal((await fetch(base+sandboxPath,{method:'POST',headers,body:'{}'})).status,429);
  assert.equal((await pending).status,503);
 }finally{await close(ingress);await close(upstream);}
});
test('incomplete body times out and releases the ingress slot',async()=>{
 const ingress=createWebhookIngress({bodyTimeoutMs:40,concurrency:1});await listen(ingress);
 try{
  const code=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:ingress.address().port,path:sandboxPath,method:'POST',headers:{...headers,'content-length':'100'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.write('{');});
  assert.equal(code,408);
 }finally{await close(ingress);}
});
