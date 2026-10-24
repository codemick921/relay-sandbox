import {migrateWhenReady} from './startup.mjs';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {InputError,address,pence} from '../server/validation.mjs';
import {createSandboxPayService} from '../server/pay-sandbox.mjs';
import {verifyWebhook} from '../server/pay-webhooks.mjs';
import {createPool,createStore,digest,orderView} from './db.mjs';
import {config as readConfig} from './config.mjs';
const dist=fileURLToPath(new URL('../dist/',import.meta.url));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const cookie='__Host-relay_sandbox';
const getToken=req=>(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookie+'='))?.slice(cookie.length+1);
async function body(req,max=16384){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>max)throw new InputError('Request too large.',413);chunks.push(chunk);}return Buffer.concat(chunks);}
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
export function createHostedServer({store,config,pay=createSandboxPayService(),staticRoot=dist,allowHttpForTests=false}){
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Strict-Transport-Security','max-age=31536000');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   // Health probes disclose no customer/provider state and require no proxy headers.
   if(req.url==='/healthz'&&req.method==='GET'){try{await store.query('SELECT 1');return send(res,200,{ok:true,mode:'sandbox'});}catch{return send(res,503,{ok:false});}}
   if(req.headers.host!==config.host)return send(res,421,{error:'Unexpected host.'});
   if(!allowHttpForTests&&req.headers['x-forwarded-proto']!=='https'){
    if(req.method==='GET'){res.writeHead(308,{Location:config.origin+'/'});return res.end();}return send(res,400,{error:'HTTPS required.'});
   }
   const url=new URL(req.url,config.origin);
   if(url.pathname==='/api/webhooks/peer/sandbox'){
    if(req.method!=='POST')throw new InputError('Method not allowed.',405);
    if(!String(req.headers['content-type']).startsWith('application/json'))throw new InputError('JSON required.',415);
    const event=verifyWebhook(await body(req,262144),req.headers,config.webhook);
    if(event.environment!=='SANDBOX')throw new InputError('Sandbox webhook required.',403);
    const accepted=await store.accept(event);return send(res,202,{accepted:true,...accepted});
   }
   if(!url.pathname.startsWith('/api/')){
    if(req.method!=='GET')throw new InputError('Not found.',404);
    const decoded=decodeURIComponent(url.pathname);if(decoded!=='/'&&!/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|svg)$/.test(decoded))throw new InputError('Not found.',404);
    const file=path.join(staticRoot,decoded==='/'?'index.html':decoded.slice(1));const data=await readFile(file);res.setHeader('Content-Type',({'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'})[path.extname(file)]);return res.end(data);
   }
   const allowed=new Set(['/api/access','/api/login','/api/logout','/api/state','/api/agents','/api/checkouts','/api/checkout-resume','/api/checkout-refresh','/api/checkout-setup']);
   if(!allowed.has(url.pathname))throw new InputError('Not found.',404);
   if(req.headers['sec-fetch-site']==='cross-site')throw new InputError('Cross-site access blocked.',403);
   if(req.method==='POST'&&(req.headers.origin!==config.origin||!String(req.headers['content-type']).startsWith('application/json')))throw new InputError('Same-origin JSON required.',403);
   if(!['GET','POST'].includes(req.method))throw new InputError('Method not allowed.',405);
   let b={};if(req.method==='POST'){try{b=JSON.parse((await body(req)).toString());}catch(e){if(e instanceof InputError)throw e;throw new InputError('Invalid JSON.');}if(!b||typeof b!=='object'||Array.isArray(b))throw new InputError('Invalid request.');}
   if(url.pathname==='/api/login'&&req.method==='POST'){
    // The global DB-backed cap cannot be bypassed with forged forwarding headers or parallel instances.
    await store.rate('login:global',50,900);
    const presented=digest(typeof b.code==='string'?b.code.slice(0,256):'');let principal=null;
    for(const p of config.testers)if(timingSafeEqual(Buffer.from(p.sha256hex,'hex'),Buffer.from(presented,'hex')))principal=p;
    if(!principal)throw new InputError('Access code not recognised.',401);
    const token=randomBytes(32).toString('hex');await store.login(token,principal);
    res.setHeader('Set-Cookie',`${cookie}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);return send(res,200,{authenticated:true,hostedSandbox:true});
   }
   const owner=await store.session(getToken(req),config.testers);
   if(url.pathname==='/api/access'&&req.method==='GET')return send(res,200,{hostedSandbox:true,authenticated:!!owner});
   if(!owner)throw new InputError('Sign in to the private sandbox.',401);
   if(req.method==='GET'){
    await store.rate('read:'+owner,120,60);
    if(url.pathname==='/api/state')return send(res,200,await store.state(owner));
    if(url.pathname==='/api/checkout-setup')return send(res,200,await pay.readiness());
    throw new InputError('Not found.',404);
   }
   await store.rate('mutation:'+owner,30,60);
   switch(url.pathname){
    case '/api/logout':await store.logout(getToken(req));res.setHeader('Set-Cookie',`${cookie}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);return send(res,200,{authenticated:false});
    case '/api/agents':{
     const name=typeof b.name==='string'?b.name.trim():'';if(name.length<2||name.length>60||b.own!==true||b.network!=='base')throw new InputError('Enter a name and confirm your own Base wallet.');
     await store.addAgent(owner,{id:randomUUID(),name,address:address(b.address),network:'Base',token:'USDC',ownership:'self_declared_unverified'});break;
    }
    case '/api/checkouts':{
     if(b.confirm!==true||b.consent!==true||!uuid(b.requestId)||!uuid(b.agentId))throw new InputError('Review the destination and confirm sharing it with Peer Pay.');
     const order=await store.createOrder(owner,{requestId:b.requestId,agentId:b.agentId,amount:pence(b.amount)});
     const claim=await store.claimCreate(owner,order.id);
     if(claim){try{await store.apply(claim,await pay.create(orderView(claim),config.origin),{creation:true});}catch{await store.fail(claim,'Checkout creation needs recovery. Keep this order; an operator must reconcile it before another attempt.');}}
     break;
    }
    case '/api/checkout-resume':case '/api/checkout-refresh':{
     if(!uuid(b.id))throw new InputError('Order not found.',404);
     const order=await store.owned(owner,b.id);
     if(!order.provider_id)throw new InputError('Creation is unresolved. Keep this order for operator recovery; no new checkout has been created.',409);
     // Browser requests only schedule work; the worker owns provider reads and fenced writes.
     await store.schedule(owner,b.id);break;
    }
    default:throw new InputError('Not found.',404);
   }
   return send(res,200,await store.state(owner));
  }catch(e){if(!res.headersSent)send(res,e instanceof InputError?e.status:e.code==='ENOENT'?404:503,{error:e instanceof InputError?e.message:'Service temporarily unavailable. Your saved records are retained.'});else res.end();}
 });
 server.requestTimeout=20000;server.headersTimeout=15000;
 return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const config=readConfig(),store=createStore(createPool());await migrateWhenReady(store);
 const server=createHostedServer({store,config});server.listen(Number(process.env.PORT??10000),'0.0.0.0',()=>console.log('Relay hosted sandbox ready.'));
 let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(closing)return;closing=true;server.close(async()=>{await store.close();process.exit(0);});setTimeout(()=>process.exit(1),25000).unref();});
}
