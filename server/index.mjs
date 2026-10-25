import http from 'node:http';
import {createPayService} from './pay.mjs';
import {atomicJson,verifyWebhook,createWebhookInbox,webhookConnections} from './pay-webhooks.mjs';
import {prepareOrder,reconcile,publicOrder,proxyRpc,hash} from './live.mjs';
import {randomUUID} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {InputError,address,pence,getOffers,practiceQuote,advance} from './peer.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function createApp({persistFile=null,offerService=(b)=>getOffers(b,{includeExecution:true}),prepareService=prepareOrder,reconcileService=reconcile,rpcService=proxyRpc,payService=createPayService(),initialSession=null,cookieName='relay_peer_session',webhooks=webhookConnections(),inboxFile=persistFile?persistFile+'.webhooks':null,workerIntervalMs=15000,now=()=>Date.now()}={}){
 let sessions=persistFile&&existsSync(persistFile)?JSON.parse(readFileSync(persistFile,'utf8')):{};
 const save=()=>{if(persistFile)atomicJson(persistFile,sessions);};
 const inbox=createWebhookInbox({file:inboxFile});
 const locks=new Set();
 const publicQuote=q=>q?Object.fromEntries(Object.entries(q).filter(([k])=>k!=='_execution')):q;
 const view=s=>({...s,lastQuote:publicQuote(s.lastQuote),orders:s.orders.map(publicOrder)});
 const initial=()=>initialSession?initialSession():({agents:[],orders:[],lastQuote:null});
 const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 const applyCheckout=async order=>{
  const update=await payService.refresh(order);
  // Single synchronous commit after network reads prevents cross-session reuse.
  for(const payment of update.verification?.payments??[]){
   if(!payment.intentHash)continue;
   const conflict=Object.values(sessions).some(session=>session.orders.some(other=>other.id!==order.id&&
    (other.intentHash?.toLowerCase()===payment.intentHash.toLowerCase()||other.verification?.payments?.some(p=>p.id===payment.id||p.intentHash?.toLowerCase()===payment.intentHash.toLowerCase()||p.transactionHash?.toLowerCase()===payment.transactionHash.toLowerCase()))));
   if(conflict)throw new InputError('This payment receipt is already attached to another Eupova order.',409);
  }
  if(update.status!==order.status){order.events??=[];order.events.push({status:update.status,at:new Date(now()).toISOString()});}
  Object.assign(order,update,{trackingError:null,nextCheckAt:now()+(update.status==='checkout_received'?3600000:30000)});
  save();
 };
 let ticking=false,closing=false;
 async function tick(){
  if(ticking||closing)return;ticking=true;
  try{
   const events=inbox.pending(now());
   const candidates=[];
   for(const [sid,session] of Object.entries(sessions))for(const order of session.orders){
    if(order.kind!=='checkout'||!order.providerOrderId||order.fixture)continue;
    const hints=events.filter(e=>e.orderId===order.providerOrderId&&e.merchantId===order.merchantId&&e.environment===(order.source==='live'?'LIVE':'SANDBOX'));
    const automatic=order.source==='live'||!['sandbox_complete','checkout_cancelled'].includes(order.status);
    if(hints.length||(automatic&&(!order.nextCheckAt||order.nextCheckAt<=now())))candidates.push({sid,order,hints});
   }
   candidates.sort((a,b)=>(a.order.nextCheckAt??0)-(b.order.nextCheckAt??0));
   const handled=new Set();
   for(const {sid,order,hints} of candidates.slice(0,5)){
    if(closing)break;if(locks.has(sid))continue;locks.add(sid);
    try{await applyCheckout(order);for(const e of hints){inbox.finish(e.id,now());handled.add(e.id);}}
    catch(e){order.trackingError=e instanceof InputError?e.message:'Verification is temporarily unavailable. The last verified result is retained.';order.trackingAttemptedAt=new Date(now()).toISOString();order.nextCheckAt=now()+60000;save();for(const e of hints){inbox.retry(e.id,now());handled.add(e.id);}}
    finally{locks.delete(sid);}
   }
   // Unknown orders are retained: a notification may precede creation's local commit.
   for(const e of events)if(!handled.has(e.id))inbox.retry(e.id,now());
  }finally{ticking=false;}
 }
 const server=http.createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.zkp2p.xyz https://attestation-service.zkp2p.xyz https://indexer.zkp2p.xyz; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 const host=req.headers.host??'';if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host))return send(res,403,{error:'Local access only.'});
 let url;try{url=new URL(req.url,'http://'+host);}catch{return send(res,400,{error:'Invalid URL.'});}
 if(!url.pathname.startsWith('/api/')){if(req.method!=='GET')return send(res,405,{error:'Method not allowed.'});try{const f=path.resolve(root,'dist',url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)));if(!f.startsWith(path.join(root,'dist')+path.sep))return send(res,404,{error:'Not found.'});res.setHeader('Content-Type',({'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'})[path.extname(f)]??'application/octet-stream');res.end(readFileSync(f));}catch{send(res,404,{error:'Not found. Build the app first.'});}return;}
 if(url.pathname.startsWith('/api/webhooks/peer/')){
  const environment=url.pathname.slice('/api/webhooks/peer/'.length),connection=webhooks[environment];
  if(req.method!=='POST')return send(res,405,{error:'Method not allowed.'});
  if(!connection)return send(res,404,{error:'Not found.'});
  if(!String(req.headers['content-type']).startsWith('application/json'))return send(res,415,{error:'JSON required.'});
  try{
   const chunks=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>262144)throw new InputError('Webhook body too large.',413);chunks.push(chunk);}
   const event=verifyWebhook(Buffer.concat(chunks),req.headers,{...connection,now:now()});
   const result=inbox.accept(event,now()); // Durable commit before acknowledgement; no snapshot grants receipt status.
   send(res,202,{accepted:true,duplicate:result.duplicate});
   if(workerIntervalMs>0)setImmediate(()=>tick().catch(()=>{}));
  }catch(e){send(res,e.status??500,{error:e instanceof InputError?e.message:'Webhook could not be saved. Retry delivery.'});}
  return;
 }
 if(req.headers['sec-fetch-site']==='cross-site')return send(res,403,{error:'Cross-site access blocked.'});
 if(req.method==='POST'&&(req.headers.origin!==`http://${host}`||!String(req.headers['content-type']).startsWith('application/json')))return send(res,403,{error:'Same-origin JSON required.'});
 let sid=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);if(!sid||!/^[a-f0-9-]{36}$/.test(sid)||!Object.hasOwn(sessions,sid)){sid=randomUUID();sessions[sid]=initial();save();res.setHeader('Set-Cookie',` ${cookieName}=${sid}; HttpOnly; SameSite=Strict; Path=/`);}
 const s=sessions[sid];if(req.method==='GET'&&url.pathname==='/api/state')return send(res,200,view(s));if(req.method==='GET'&&url.pathname==='/api/checkout-setup')return send(res,200,await payService.readiness());if(req.method!=='POST')return send(res,404,{error:'Not found.'});
 if(locks.has(sid))return send(res,409,{error:'An action is running. Please wait.'});locks.add(sid);
 try{let raw='';for await(const c of req){raw+=c;if(raw.length>(url.pathname==='/api/rpc'?65536:8192))throw new InputError('Request too large.',413);}let b;try{b=JSON.parse(raw);}catch{throw new InputError('Invalid JSON.');}if(!b||typeof b!=='object'||Array.isArray(b))throw new InputError('Invalid request.');
 switch(url.pathname){
 case '/api/checkouts': {
   if(b.confirm!==true||b.consent!==true||!/^([a-f0-9]{8}-[a-f0-9-]{27})$/.test(b.requestId??''))throw new InputError('Review the destination and confirm sharing it with Peer Pay.');
   const agent=s.agents.find(a=>a.id===b.agentId),amount=pence(b.amount);
   if(!agent)throw new InputError('Choose a saved Base agent wallet.');
   let order=s.orders.find(o=>o.requestId===b.requestId);
   if(order){
     if(order.kind!=='checkout'||order.agent.id!==agent.id||order.quote.pence!==amount)throw new InputError('This request belongs to another order.',409);
     if(order.providerOrderId)break;
   }else{
     if(s.orders.length>=100)throw new InputError('Prototype order limit reached.');
     if(s.orders.some(o=>o.kind==='checkout'&&!['sandbox_complete','checkout_cancelled','checkout_received'].includes(o.status)))throw new InputError('Resume your existing checkout before starting another.',409);
     const setup=await payService.readiness();if(!setup.ready)throw new InputError(setup.reason,503);
     order={id:randomUUID(),requestId:b.requestId,kind:'checkout',source:'sandbox',agent:{...agent},quote:{pence:amount,platform:'wise',network:'Base',token:'USDC'},status:'checkout_unknown',createdAt:new Date().toISOString(),events:[]};
     s.orders.unshift(order);save(); // Persist the stable key before any external creation request.
   }
   Object.assign(order,await payService.create(order,`http://${host}`));break;
 }
 case '/api/checkout-resume': {
   const o=s.orders.find(o=>o.id===b.id&&o.kind==='checkout');if(!o)throw new InputError('Order not found.',404);
   if(!o.providerOrderId)Object.assign(o,await payService.create(o,`http://${host}`));break;
 }
 case '/api/checkout-refresh': {
   const o=s.orders.find(o=>o.id===b.id&&o.kind==='checkout');if(!o)throw new InputError('Order not found.',404);
   if(o.checkedAt&&Date.now()-Date.parse(o.checkedAt)<4000)break;
   try{await applyCheckout(o);}catch(e){o.trackingError=e instanceof InputError?e.message:'Verification is temporarily unavailable.';o.trackingAttemptedAt=new Date(now()).toISOString();save();throw e;}break;
 }
 case '/api/rpc':return send(res,200,await rpcService(b));
 case '/api/agents': {const name=typeof b.name==='string'?b.name.trim():'';if(name.length<2||name.length>60||b.own!==true||b.network!=='base')throw new InputError('Enter a name and confirm your own Base wallet.');if(s.agents.length>=5)throw new InputError('This prototype supports five wallets.');const a=address(b.address);if(s.agents.some(x=>x.address.toLowerCase()===a.toLowerCase()))throw new InputError('This wallet is already saved.');s.agents.push({id:randomUUID(),name,address:a,network:'Base',token:'USDC',ownership:'self_declared_unverified'});break;}
 case '/api/offers':{if(b.sample!==true){const agent=s.agents.find(a=>a.id===b.agentId);if(!agent||typeof b.recipient!=='string'||agent.address.toLowerCase()!==b.recipient.toLowerCase())throw new InputError('Choose a saved agent whose address matches this destination.');}s.lastQuote=null;save();const quote=await offerService(b);s.lastQuote={...quote,id:randomUUID(),agentId:b.sample===true?null:b.agentId??null};save();return send(res,200,publicQuote(s.lastQuote));}
 case '/api/practice-quote':return send(res,200,practiceQuote(b));
 case '/api/practice-order':{if(b.confirm!==true)throw new InputError('Confirm this is a practice order.');const agent=s.agents.find(a=>a.id===b.agentId);if(!agent)throw new InputError('Save and select an agent wallet.');if(typeof b.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(b.requestId))throw new InputError('A request ID is required.');const q=practiceQuote(b);const old=s.orders.find(x=>x.requestId===b.requestId);if(old){if(old.agent.id!==agent.id||old.quote.pence!==q.pence||old.quote.platform!==q.platform)throw new InputError('Request ID already used for another order.',409);break;}if(s.orders.length>=100)throw new InputError('Prototype activity limit reached.');s.orders.unshift({id:randomUUID(),requestId:b.requestId,source:'practice',agent:{...agent},quote:q,status:'offer_selected',createdAt:new Date().toISOString(),events:[{status:'offer_selected',at:new Date().toISOString()}]});break;}
 case '/api/advance':{const o=s.orders.find(o=>o.id===b.id);if(!o)throw new InputError('Order not found.',404);advance(o,b.expected);break;}
 case '/api/handoff':{const q=s.lastQuote;if(!q||!q.offers.length||q.id!==b.quoteId||!Number.isFinite(Date.parse(q.expiresAt))||Date.parse(q.expiresAt)<=Date.now())throw new InputError('This offer search expired. Refresh before continuing.',409);if(b.confirm!==true)throw new InputError('Confirm that payment continues on Peer.');if(s.orders.some(o=>o.quoteId===q.id))break;s.orders.unshift({id:randomUUID(),quoteId:q.id,source:'live',quote:publicQuote(q),status:'handoff_prepared',createdAt:new Date().toISOString(),events:[]});break;}
 case '/api/live-orders': {
   const old=s.orders.find(o=>o.kind==='native'&&o.requestId===b.requestId);
   if(old){if(old.quoteId!==b.quoteId||old.offerId!==b.offerId)throw new InputError('Request already used for another offer.',409);break;}
   const q=s.lastQuote,raw=q?._execution?.[Number(b.offerId)];
   if(b.confirm!==true||!/^([a-f0-9]{8}-[a-f0-9-]{27})$/.test(b.requestId??''))throw new InputError('Review and confirm the live order.');
   if(!q||q.id!==b.quoteId||q.sample||!q.agentId||!q.offers.some(o=>o.id===b.offerId)||!raw||Date.parse(q.expiresAt)<=Date.now())throw new InputError('Choose a fresh personalised offer.',409);
   if(s.orders.length>=100)throw new InputError('Prototype order limit reached.');
   if(s.orders.some(o=>o.kind==='native'&&o.quote.payer.toLowerCase()===q.payer.toLowerCase()&&!['received','reservation_failed','abandoned'].includes(o.status)))throw new InputError('Resolve the existing order for this buying wallet before starting another.',409);
   const prepared=await prepareService(q,raw);
   s.orders.unshift({id:randomUUID(),kind:'native',source:'live',requestId:b.requestId,quoteId:q.id,offerId:b.offerId,quote:publicQuote(q),agent:{...s.agents.find(a=>a.id===q.agentId)},...prepared,status:'ready_to_reserve',createdAt:new Date().toISOString(),events:[]});break;
 }
 case '/api/live-attempt': {
   const o=s.orders.find(o=>o.id===b.id&&o.kind==='native');if(!o)throw new InputError('Order not found.',404);
   if(b.phase==='reserve'){
     if(o.status!=='ready_to_reserve'||Date.parse(o.tx.expiresAt)<=Date.now()||Date.parse(o.quote.expiresAt)<=Date.now())throw new InputError('This order cannot be submitted. Refresh or recover its transaction.',409);
     o.status='reservation_unknown';o.reservationAttempt=true;
   }else if(b.phase==='release'){
     const update=await reconcileService(o);Object.assign(o,update);
     if(o.status!=='awaiting_payment'||o.releaseAttempt)throw new InputError('This order cannot start another release. Check its current status.',409);
     o.releaseAttempt=true;o.status='release_unknown';
   }else throw new InputError('Invalid approval phase.');
   o.events.push({status:o.status,at:new Date().toISOString()});break;
 }
 case '/api/live-rejected': {
   const o=s.orders.find(o=>o.id===b.id&&o.kind==='native');if(!o)throw new InputError('Order not found.',404);
   if(b.phase==='reserve'&&o.status==='reservation_unknown'&&!o.reservationTx){o.status='ready_to_reserve';o.reservationAttempt=false;}
   else if(b.phase==='release'&&o.status==='release_unknown'&&!o.releaseTx){o.status='awaiting_payment';o.releaseAttempt=false;}
   else throw new InputError('The transaction may have been submitted. Reconcile it first.',409);break;
 }
 case '/api/live-abandon': {
   const o=s.orders.find(o=>o.id===b.id&&o.kind==='native');if(!o)throw new InputError('Order not found.',404);
   if(o.status!=='ready_to_reserve'||o.reservationAttempt||o.reservationTx)throw new InputError('An attempted order cannot be discarded. Recover its transaction.',409);
   o.status='abandoned';break;
 }
 case '/api/live-submitted': {
   const o=s.orders.find(o=>o.id===b.id&&o.kind==='native');if(!o)throw new InputError('Order not found.',404);
   const h=hash(b.hash);const key=b.phase==='reserve'?'reservationTx':b.phase==='release'?'releaseTx':null;
   if(!key||(key==='reservationTx'&&!o.reservationAttempt)||(key==='releaseTx'&&!o.intentHash))throw new InputError('The order is not ready for this transaction.',409);
   if(o[key]&&o[key].toLowerCase()!==h.toLowerCase())throw new InputError('A transaction is already recorded. Do not submit a replacement here.',409);
   o[key]=h;o.status=key==='reservationTx'?'reservation_pending':'release_pending';o.events.push({status:o.status,at:new Date().toISOString()});break;
 }
 case '/api/live-refresh': {
   const o=s.orders.find(o=>o.id===b.id&&o.kind==='native');if(!o)throw new InputError('Order not found.',404);
   if(o.status==='received')break;
   if(o.checkedAt&&Date.now()-Date.parse(o.checkedAt)<4000)break;
   o.checkedAt=new Date().toISOString();const update=await reconcileService(o);
   if(update.intentHash&&Object.values(sessions).some(session=>session.orders.some(other=>other.id!==o.id&&(other.intentHash?.toLowerCase()===update.intentHash.toLowerCase()||other.verification?.payments?.some(p=>p.intentHash?.toLowerCase()===update.intentHash.toLowerCase())))))throw new InputError('This Peer intent is already linked to another order.',409);
   if(o.status!==update.status)o.events.push({status:update.status,at:new Date().toISOString()});Object.assign(o,update);break;
 }
 default:throw new InputError('Not found.',404);
 }save();send(res,200,view(s));
 }catch(e){send(res,e.status??500,{error:e instanceof InputError?e.message:'The request could not be verified. Check the order before retrying any transaction.'});}finally{locks.delete(sid);}
 });
 // These checks live only as long as this app process. No OS scheduler is installed.
 let timer;
 server.on('listening',()=>{if(workerIntervalMs>0){timer=setInterval(()=>tick().catch(()=>{}),workerIntervalMs);timer.unref();setImmediate(()=>tick().catch(()=>{}));}});
 server.on('close',()=>{closing=true;clearInterval(timer);});
 server.reconcileCheckouts=tick;
 server.webhookStats=()=>inbox.stats();
 server.requestTimeout=20000;server.headersTimeout=15000;
 return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const server=createApp({persistFile:path.join(root,'.data','peer-sessions.json')});server.listen(Number(process.env.PORT??4319),'127.0.0.1',()=>console.log('Eupova Peer running on loopback. User-approved Peer orders; server signing disabled.'));}
