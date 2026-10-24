import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {createLiveStore,liveOrderView} from '../hosted/live-store.mjs';
import {createLiveWorker} from '../hosted/live-worker.mjs';
import {createLiveTrackingHandler} from '../hosted/live-http.mjs';
import {createLiveReadService,TrackingReviewError} from '../server/pay-readonly.mjs';
import {verifyPayDelivery} from '../server/pay-delivery.mjs';
import {verifyWebhook} from '../server/pay-webhooks.mjs';
import {digest,createStore} from '../hosted/db.mjs';
import {config} from '../hosted/config.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {local,remote,payment,rpc,receipt} from './fixtures/live-evidence.mjs';

async function fixture(directory){
 if(process.env.TEST_DATABASE_URL){
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});const schema='test_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options={connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:8};
  let pool=new pg.Pool(options),store=createLiveStore(pool,{merchantId:'merchant'});await store.migrate();
  return {get store(){return store;},get pool(){return pool;},reconnect:async()=>{await pool.end();pool=new pg.Pool(options);store=createLiveStore(pool,{merchantId:'merchant'});await store.migrate();},close:async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
 }
 const db=new PGlite(directory);let tail=Promise.resolve();
 async function connect(){let release;const old=tail;tail=new Promise(r=>release=r);await old;return {query:async(sql,args=[])=>sql.includes('CREATE TABLE')?(await db.exec(sql)).at(-1):db.query(sql,args),release};}
 const pool={connect,query:async(sql,args)=>{const c=await connect();try{return await c.query(sql,args);}finally{c.release();}},end:()=>db.close()};
 const store=createLiveStore(pool,{merchantId:'merchant'});await store.migrate();return {pool,store,close:()=>pool.end()};
}
const intent=(overrides={})=>({...local(),id:randomUUID(),requestedUsdcAmount:'12.5',agent:{...local().agent,id:randomUUID(),network:'Base',token:'USDC'},...overrides});
const remoteFor=(o,overrides={})=>({...remote(),id:o.providerOrderId,notes:{relayOrderId:o.id},...overrides});
const paymentFor=(o,overrides={})=>({...payment(),orderId:o.providerOrderId,...overrides});
async function verified(o,{chain=rpc(),payments=[paymentFor(o)],provider=remoteFor(o)}={}){
 const r=await verifyPayDelivery(o,provider,payments,{rpc:chain});
 return {...r,providerStatus:provider.status,chargebackStatus:'NONE',checkedAt:r.verification.checkedAt};
}
const event=(o,id='event1')=>({environment:'LIVE',merchantId:'merchant',eventId:id,digest:digest(id),deliveryId:'delivery1',orderId:o.providerOrderId,type:'PAYMENT_SETTLED',test:false});
const due=(s,id)=>s.query("UPDATE relay_live_orders SET next_check_at=now(),lease_until=now()-interval '1 second' WHERE id=$1",[id]);

test('live intents are immutable, owner-bound, idempotent and separate from sandbox',async()=>{
 const f=await fixture();try{
  const s=f.store,o=intent();await s.bindTrustedOrder('alice',o);
  assert.equal((await s.bindTrustedOrder('alice',o)).id,o.id);
  assert.equal((await s.state('bob')).orders.length,0);await assert.rejects(s.owned('bob',o.id),/not found/);
  await assert.rejects(s.bindTrustedOrder('alice',{...o,agent:{...o.agent,address:'0x'+'22'.repeat(20)}}),/cannot change/);
  await assert.rejects(s.query("UPDATE relay_live_orders SET owner='bob' WHERE id=$1",[o.id]),/Immutable/);
  await assert.rejects(s.bindTrustedOrder('alice',{...o,source:'sandbox'}),/Invalid trusted/);
  await assert.rejects(s.bindTrustedOrder('alice',{...o,merchantId:'elsewhere'}),/Wrong merchant/);
  await assert.rejects(s.accept({...event(o),environment:'SANDBOX'}),/Wrong webhook/);
  const sandbox=createStore(f.pool);await sandbox.migrate();assert.equal((await sandbox.state('alice')).orders.length,0);
  await assert.rejects(sandbox.query('INSERT INTO relay_orders(id,owner,request_id,request) VALUES($1,$2,$3,$4)',[randomUUID(),'alice',randomUUID(),o]));
 }finally{await f.close();}
});

test('fresh API and exact receipt evidence move an order from pending to finalised',async()=>{
 const f=await fixture();try{
  const s=f.store,o=intent();await s.bindTrustedOrder('alice',o);let head=119n;const calls=[];
  const chain=rpc({getBlock:async()=>({hash:receipt().blockHash,number:head})});
  // Canonical block still 120; only the finalised head moves.
  chain.getBlock=async({blockTag})=>({hash:receipt().blockHash,number:blockTag==='finalized'?head:120n});
  const pay=createLiveReadService({apiKey:'fixture-secret',merchantId:'merchant',rpc:chain,fetcher:async(url,options)=>{
   calls.push([url,options]);return new Response(JSON.stringify({success:true,responseObject:url.endsWith('/me')?{id:'merchant',environment:'LIVE'}:url.endsWith('/payments')?{payments:[paymentFor(o)]}:{merchant:{id:'merchant',environment:'LIVE'},order:remoteFor(o),currentPayment:paymentFor(o)}}));
  }});
  const worker=createLiveWorker({store:s,pay});await worker.tick();let state=(await s.state('alice')).orders[0];
  assert.equal(state.status,'checkout_confirming');assert.equal(state.delivery,null);assert.equal(state.verification.receivedRaw,'0');
  head=120n;await due(s,o.id);await worker.tick();state=(await s.state('alice')).orders[0];
  assert.equal(state.status,'checkout_received');assert.equal(state.delivery.amountRaw,'12000000');
  assert.ok(calls.every(([,i])=>i.method==='GET'&&i.redirect==='error'&&i.headers['X-API-Key']==='fixture-secret'));
  assert.ok(!JSON.stringify(state).includes('fixture-secret'));assert.equal(pay.create,undefined);
  assert.equal((await s.query('SELECT * FROM relay_live_payments')).rows.length,1);
  await due(s,o.id);await worker.tick();assert.equal((await s.query('SELECT * FROM relay_live_payments')).rows.length,1);
 }finally{await f.close();}
});

test('partial arrivals reserve receipts globally before the order completes',async()=>{
 const f=await fixture();try{
  const s=f.store,a=intent(),b=intent({providerOrderId:'peer-second'});await s.bindTrustedOrder('alice',a);await s.bindTrustedOrder('bob',b);
  const ca=await s.claimNext();const partial=await verified(a,{provider:remoteFor(a,{status:'PARTIALLY_FULFILLED',remainingUsdcAmount:'0.5'})});
  assert.equal(partial.status,'checkout_partial');await s.apply(ca,partial);
  const cb=await s.claimNext();await assert.rejects(s.apply(cb,await verified(b,{payments:[paymentFor(b,{id:'second-payment'})]})),/already bound/);
  await s.fail(cb,{review:true});assert.equal((await s.state('bob')).orders[0].status,'checkout_review');
  assert.equal((await s.state('bob')).orders[0].delivery,undefined);
  await due(s,a.id);const again=await s.claimNext();await s.apply(again,await verified(a));
  assert.equal((await s.state('alice')).orders[0].status,'checkout_received');
 }finally{await f.close();}
});

test('stale worker writes and errors cannot overwrite a newer generation',async()=>{
 const f=await fixture();try{
  const s=f.store,o=intent();await s.bindTrustedOrder('alice',o);const a=await s.claimNext();await due(s,o.id);const b=await s.claimNext();
  assert.notEqual(a.lease_token,b.lease_token);await s.apply(b,await verified(o));
  assert.equal(await s.apply(a,{status:'sandbox_complete'}),false);assert.equal(await s.fail(a,{review:true}),false);
  assert.equal((await s.state('alice')).orders[0].status,'checkout_received');
 }finally{await f.close();}
});

test('signed inbox deduplication, mid-check hints, unknown orders and late settlement',async()=>{
 const f=await fixture();try{
  const s=f.store,o=intent();await s.accept(event(o));assert.equal((await s.state('alice')).orders.length,0);
  await s.bindTrustedOrder('alice',o);const c=await s.claimNext();
  await s.apply(c,await verified(o,{provider:remoteFor(o,{status:'CANCELLED'}),payments:[]}));
  assert.equal((await s.state('alice')).orders[0].status,'checkout_cancelled');
  await s.accept(event(o,'late'));const late=await s.claimNext();await s.accept(event(o,'during-check'));
  // Force equal timestamps: the new event must survive even within one clock tick.
  await s.query("UPDATE relay_live_webhooks SET received_at=$1 WHERE event_id='during-check'",[late.claimed_at]);
  await s.apply(late,await verified(o));
  assert.equal((await s.query("SELECT * FROM relay_live_webhooks WHERE processed_at IS NULL")).rows.length,1);
  assert.ok(await s.claimNext());
  assert.equal((await s.accept({...event(o,'late'),deliveryId:'changed-unsigned-header'})).duplicate,true);
  await assert.rejects(s.accept({...event(o,'late'),digest:digest('different-body')}),/reused/);
  assert.equal((await s.state('alice')).orders[0].status,'checkout_received');
 }finally{await f.close();}
});

test('outages retain historical receipt; changed finalised evidence raises a sticky review hold',async()=>{
 const f=await fixture();try{
  const s=f.store,o=intent();await s.bindTrustedOrder('alice',o);await s.apply(await s.claimNext(),await verified(o));
  await due(s,o.id);await createLiveWorker({store:s,pay:{refresh:async()=>{throw Error('secret URL must not leak');}}}).tick();
  let st=(await s.state('alice')).orders[0];assert.equal(st.status,'checkout_received');assert.ok(st.delivery);assert.ok(st.trackingError);assert.ok(!JSON.stringify(st).includes('secret URL'));
  await due(s,o.id);const claim=await s.claimNext();await assert.rejects(s.apply(claim,await verified(o,{payments:[{...paymentFor(o),status:'CREATED'}],provider:remoteFor(o,{status:'CREATED'})})),/changed or disappeared/);
  await s.fail(claim,{review:true});st=(await s.state('alice')).orders[0];assert.equal(st.status,'checkout_review');assert.ok(st.delivery.finalized);
  await due(s,o.id);await s.apply(await s.claimNext(),await verified(o));assert.equal((await s.state('alice')).orders[0].status,'checkout_review');
 }finally{await f.close();}
});

test('restart recovers durable pending work and preserves ownership and receipts',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'relay-live-db-'));let f=await fixture(dir);const o=intent();
 try{
  await f.store.bindTrustedOrder('alice',o);await f.store.accept(event(o));if(f.reconnect)await f.reconnect();else{await f.close();f=await fixture(dir);}
  await createLiveWorker({store:f.store,pay:{refresh:o=>verified(o)}}).tick();
  assert.equal((await f.store.state('alice')).orders[0].status,'checkout_received');if(f.reconnect)await f.reconnect();else{await f.close();f=await fixture(dir);}
  assert.equal((await f.store.state('alice')).orders[0].delivery.amountRaw,'12000000');assert.equal((await f.store.state('bob')).orders.length,0);
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});

test('read adapter rejects wrong merchant, sandbox, changed destination and incomplete history',async()=>{
 const o=intent();let edit=x=>x;
 const service=createLiveReadService({apiKey:'test',merchantId:'merchant',rpc:rpc(),fetcher:async(url)=>new Response(JSON.stringify({success:true,responseObject:edit(url.endsWith('/me')?{id:'merchant',environment:'LIVE'}:url.endsWith('/payments')?{payments:[paymentFor(o)]}:{merchant:{id:'merchant',environment:'LIVE'},order:remoteFor(o)})}))});
 for(const change of [x=>x.environment?{...x,environment:'SANDBOX'}:x,x=>x.order?{...x,order:{...x.order,destinationAddress:'0x'+'22'.repeat(20)}}:x,x=>x.payments?{...x,hasMore:true}:x,x=>x.payments?{...x,totalCount:2}:x]){edit=change;await assert.rejects(service.refresh(o),TrackingReviewError);}
 let calls=0;const locked=createLiveReadService({apiKey:'test',merchantId:'merchant',rpc:rpc(),fetcher:async()=>{calls++;throw Error();}});
 await assert.rejects(locked.refresh({...o,source:'sandbox'}),TrackingReviewError);assert.equal(calls,0);
});

test('HTTP owner isolation, signature-only hints, receipt export and no order import or payment actions',async()=>{
 const f=await fixture();let server;try{
  const s=f.store,o=intent();await s.bindTrustedOrder('alice',o);const secret='fixture-hook';
  const handler=createLiveTrackingHandler({store:s,origin:'https://tracking.example',webhook:{environment:'LIVE',merchantId:'merchant',secret},authenticate:async req=>req.headers.cookie==='test=alice'?'alice':req.headers.cookie==='test=bob'?'bob':null,rateLimit:async()=>{},allowHttpForTests:true});
  server=http.createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const request=(route,{method='GET',cookie='test=alice',headers={},body}={})=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:{host:'tracking.example',cookie,origin:'https://tracking.example','content-type':'application/json',...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,text}));});r.on('error',reject);r.end(body);});
  const route='/api/live-tracking/orders/'+o.id;
  assert.equal((await request(route,{cookie:''})).status,401);assert.equal((await request(route,{cookie:'test=bob'})).status,404);
  assert.equal((await request(route+'/receipt')).status,409);assert.equal((await request('/api/live-tracking/orders',{method:'POST',body:JSON.stringify(o)})).status,404);
  assert.equal((await request(route+'/refresh',{method:'POST',headers:{origin:'https://evil.example'}})).status,403);
  const payload={id:'signed-event',type:'ORDER_FULFILLED',data:{order:{...remoteFor(o),status:'FULFILLED'},payment:paymentFor(o)}};
  const raw=JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000));
  const headers={'x-webhook-id':'delivery','x-webhook-timestamp':timestamp,'x-webhook-signature':createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex')};
  assert.equal((await request('/api/webhooks/peer/live',{method:'POST',headers,body:raw})).status,202);
  assert.equal((await request(route+'/receipt')).status,409); // signed claims are not wallet evidence
  assert.equal((await request('/api/webhooks/peer/live',{method:'POST',headers,body:raw+' '})).status,401);
  await createLiveWorker({store:s,pay:{refresh:order=>verified(order)}}).tick();
  const exported=await request(route+'/receipt');assert.equal(exported.status,200);assert.equal(JSON.parse(exported.text).delivery.amountRaw,'12000000');
  assert.equal((await request(route+'/receipt',{cookie:'test=bob'})).status,404);
  await due(s,o.id);await s.fail(await s.claimNext(),{review:true});assert.equal((await request(route+'/receipt')).status,409);
  assert.throws(()=>createLiveTrackingHandler({store:s,origin:'https://tracking.example',webhook:{}}),/requires HTTPS/);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});

test('parallel workers cannot claim the same live order (real PostgreSQL)',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{await f.store.bindTrustedOrder('alice',intent());const claims=await Promise.all([f.store.claimNext(),f.store.claimNext()]);assert.equal(claims.filter(Boolean).length,1);}finally{await f.close();}
});
test('concurrent receipt reuse commits at most one credit (real PostgreSQL)',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
  const a=intent(),b=intent({providerOrderId:'peer-second'});await f.store.bindTrustedOrder('alice',a);await f.store.bindTrustedOrder('bob',b);
  const ca=await f.store.claimNext(),cb=await f.store.claimNext();const results=await Promise.allSettled([f.store.apply(ca,await verified(a)),f.store.apply(cb,await verified(b,{payments:[paymentFor(b,{id:'second'})]}))]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await f.store.query("SELECT * FROM relay_live_orders WHERE status='checkout_received'")).rows.length,1);
 }finally{await f.close();}
});

test('tracking uses the real sign-in session, isolates owners, disables payments and gates receipts',async()=>{
 const f=await fixture();let server;try{
  const store=createStore(f.pool);await store.migrate();const o=intent();await store.addAgent('alice',o.agent);await f.store.bindTrustedOrder('alice',o);
  let providerCalls=0;const pay={readiness:async()=>{providerCalls++;},create:async()=>{providerCalls++;throw Error('must never create');}};
  const principals=['alice','bob'].map(label=>({label,sha256hex:digest('test-'+label)}));
  const cfg={origin:'https://tracking.example',host:'tracking.example',testers:principals};
  server=createHostedServer({store,config:cfg,pay,tracking:{store:f.store,simulated:true},paymentsDisabled:true,allowHttpForTests:true});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const req=(route,{cookie='',data,headers={}}={})=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method:data?'POST':'GET',headers:{host:cfg.host,origin:cfg.origin,'content-type':'application/json',cookie,...headers}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(body)}));});r.on('error',reject);r.end(data?JSON.stringify(data):undefined);});
  const route='/api/live-tracking/orders/'+o.id;
  assert.equal((await req(route)).status,401);
  const login=await req('/api/login',{data:{code:'test-alice'}});assert.equal(login.status,200);assert.match(login.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Strict/);
  const alice=login.headers['set-cookie'][0].split(';')[0],bob=(await req('/api/login',{data:{code:'test-bob'}})).headers['set-cookie'][0].split(';')[0];
  let state=(await req('/api/state',{cookie:alice})).body;assert.equal(state.paymentsDisabled,true);assert.equal(state.previewMode,true);assert.equal(state.orders[0].tracking,true);assert.equal(state.orders[0].fixture,true);assert.equal(state.orders[0].source,'fixture');
  assert.equal((await req('/api/state',{cookie:bob})).body.orders.length,0);
  assert.equal((await req('/api/live-tracking/orders',{cookie:bob})).body.orders.length,0);
  for(const suffix of ['', '/receipt','/refresh'])assert.equal((await req(route+suffix,{cookie:bob,...suffix==='/refresh'?{data:{owner:'alice'}}:{}})).status,404);
  assert.equal((await req(route+'/receipt',{cookie:alice})).status,409);
  assert.equal((await req(route+'/refresh',{cookie:alice,data:{},headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await req(route+'/refresh',{cookie:alice,data:{},headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await req('/api/checkouts',{cookie:alice,data:{agentId:o.agent.id,requestId:randomUUID(),amount:'25',confirm:true,consent:true}})).status,403);
  assert.equal((await req('/api/checkout-setup',{cookie:alice})).body.ready,false);
  assert.equal((await req('/api/checkout-refresh',{cookie:alice,data:{id:o.id}})).status,403);
  assert.equal((await req('/api/webhooks/peer/live',{data:{}})).status,404);
  assert.equal((await req('/api/webhooks/peer/sandbox',{data:{}})).status,403);
  assert.equal((await req('/api/live-tracking/orders',{cookie:alice,data:o})).status,404);
  assert.equal(providerCalls,0);
  const scheduled=await req(route+'/refresh',{cookie:alice,data:{owner:'bob'}});assert.equal(scheduled.status,202);
  await createLiveWorker({store:f.store,pay:{refresh:order=>verified(order)}}).tick();
  state=(await req('/api/state',{cookie:alice})).body;assert.equal(state.worker.healthy,true);assert.equal(state.orders[0].status,'checkout_received');
  const receipt=(await req(route+'/receipt',{cookie:alice})).body;assert.equal(receipt.simulated,true);assert.equal(receipt.environment,'SIMULATED');assert.equal(receipt.delivery.recipient,o.agent.address);assert.equal(receipt.delivery.amountRaw,'12000000');
  assert.equal((await req('/api/logout',{cookie:alice,data:{}})).status,200);assert.equal((await req(route,{cookie:alice})).status,401);
  const again=(await req('/api/login',{data:{code:'test-alice'}})).headers['set-cookie'][0].split(';')[0];
  assert.equal((await req(route+'/receipt',{cookie:again})).status,200);
  await store.query("UPDATE relay_sessions SET expires_at=now()-interval '1 second'");
  assert.equal((await req('/api/state',{cookie:again})).status,401);assert.equal((await req(route+'/receipt',{cookie:again})).status,401);
  assert.throws(()=>createHostedServer({store,config:cfg,pay,tracking:{store:f.store}}),/payments to remain disabled/);
  assert.throws(()=>createHostedServer({store,config:cfg,pay,tracking:{store:f.store,simulated:true},paymentsDisabled:true,localPreview:true}),/loopback HTTP/);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
