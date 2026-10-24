import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import http from 'node:http';
import pg from 'pg';
import {PGlite} from '@electric-sql/pglite';
import {createStore,digest} from '../hosted/db.mjs';
import {config} from '../hosted/config.mjs';
import {createPeerConnection} from '../hosted/peer-connection.mjs';
import {createHostedServer} from '../hosted/server.mjs';
const env={RELAY_MODE:'sandbox',PUBLIC_ORIGIN:'https://sandbox.example',DATABASE_URL:'postgres://fixture',SANDBOX_TESTERS:JSON.stringify([{label:'operator',sha256hex:digest('test-code')}])};
const live={RELAY_PEER_CONNECTION_MODE:'receive_only',PEER_PAY_LIVE_API_KEY:'fixture-live-key',PEER_PAY_LIVE_WEBHOOK_SECRET:'fixture-live-secret',PEER_PAY_LIVE_MERCHANT_ID:'merchant-live'};
const settings=()=>config({...env,...live});
const fetcher=async(url,init)=>{assert.equal(url,'https://api.pay.peer.xyz/api/v1/merchants/me');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.body,undefined);return new Response(JSON.stringify({success:true,responseObject:{id:'merchant-live',environment:'LIVE',merchantConfig:{enabledRails:['wise']},apiKey:'must-not-leak'}}));};
const signed=(id=randomUUID(),extra={})=>{
 const payload={id,type:'ORDER_CREATED',data:{test:true,order:null,payment:null},...extra};
 const raw=Buffer.from(JSON.stringify(payload)),timestamp=String(Math.floor(Date.now()/1000));
 return {raw,headers:{'content-type':'application/json','x-webhook-timestamp':timestamp,'x-webhook-signature':createHmac('sha256',live.PEER_PAY_LIVE_WEBHOOK_SECRET).update(timestamp+'.').update(raw).digest('hex'),'x-webhook-id':randomUUID()}};
};
async function fixture(){
 if(process.env.TEST_DATABASE_URL){
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='test_'+randomUUID().replaceAll('-','');await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:5}),store=createStore(pool);await store.migrate();
  return {store,close:async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
 }
 const db=new PGlite();let tail=Promise.resolve();
 const connect=async()=>{let release;const previous=tail;tail=new Promise(r=>release=r);await previous;return {query:(sql,args=[])=>sql.includes('CREATE TABLE')?db.exec(sql).then(r=>r.at(-1)):db.query(sql,args),release};};
 const pool={connect,query:async(sql,args)=>{const c=await connect();try{return await c.query(sql,args);}finally{c.release();}}},store=createStore(pool);await store.migrate();return {store,close:()=>db.close()};
}
test('connection config is web-only, explicit, complete, separate and cannot enable payments',()=>{
 const c=settings();assert.equal(c.paymentsDisabled,true);assert.equal(c.providerConnectionsEnabled,false);assert.equal(c.trackingSandbox,true);
 assert.ok(!JSON.stringify(c).includes('fixture-live-key'));assert.ok(!JSON.stringify(c).includes('fixture-live-secret'));
 assert.throws(()=>config({...env,...live},{worker:true}),/worker|Live credentials/);
 assert.throws(()=>config({...env,...live,RELAY_PEER_CONNECTION_MODE:'live'}),/Unsupported/);
 assert.throws(()=>config({...env,...live,RELAY_PEER_CONNECTION_MODE:'disabled'}),/Live credentials/);
 assert.throws(()=>config({...env,...live,PEER_PAY_LIVE_READ_API_KEY:'extra'}),/unsupported/);
 for(const key of Object.keys(live).filter(k=>k.startsWith('PEER_')))assert.throws(()=>config({...env,...live,[key]:''}),/Incomplete/);
 assert.throws(()=>config({...env,...live,PEER_PAY_SANDBOX_WEBHOOK_SECRET:live.PEER_PAY_LIVE_WEBHOOK_SECRET}),/distinct/);
 assert.equal(config({...env,...live,RELAY_PAYMENTS_ENABLED:'true'}).paymentsDisabled,true);
 assert.ok(!readFileSync(new URL('../hosted/worker.mjs',import.meta.url),'utf8').includes('peer-connection'));
});
test('identity is fixed GET, safe to expose and fail-closed on mismatch or outage',async()=>{
 const store={query:async()=>({rows:[{total:0,tests:0,last_received_at:null}]}),tx:()=>assert.fail('No inbox access permitted')};
 const good=createPeerConnection({connection:settings().liveConnection,store,fetcher});await good.checkIdentity();assert.equal((await good.status()).identity.status,'verified');
 assert.ok(!JSON.stringify(await good.status()).includes('must-not-leak'));
 for(const bad of [async()=>{throw Error('private credential in error');},async()=>new Response('{}',{status:401}),async()=>new Response(JSON.stringify({success:true,responseObject:{id:'other',environment:'LIVE'}})),async()=>new Response(JSON.stringify({success:true,responseObject:{id:'merchant-live',environment:'SANDBOX'}}))]){
  const c=createPeerConnection({connection:settings().liveConnection,store,fetcher:bad});await c.checkIdentity();const e=signed();await assert.rejects(c.accept(e.raw,e.headers),e=>e.status===503);assert.ok(!JSON.stringify(await c.status()).includes('private credential'));
 }
});
test('signed events persist once, reject conflicts and do not change orders or customer state',async()=>{
 const f=await fixture();try{
  const c=createPeerConnection({connection:settings().liveConnection,store:f.store,fetcher});await c.migrate();await c.checkIdentity();
  const before=(await f.store.query('SELECT count(*) AS n FROM relay_orders')).rows;
  const e=signed('same-event');const results=await Promise.all([c.accept(e.raw,e.headers),c.accept(e.raw,{...e.headers,'x-webhook-id':'unsigned-change'})]);assert.equal(results.filter(r=>!r.duplicate).length,1);
  const conflict=signed('same-event',{type:'ORDER_CANCELLED',data:{order:{id:'peer-order',merchantId:'merchant-live'}}});await assert.rejects(c.accept(conflict.raw,conflict.headers),e=>e.status===409);
  const payment=signed('payment-event',{type:'PAYMENT_SETTLED',data:{order:{id:'peer-order',merchantId:'merchant-live',notes:{relayOrderId:randomUUID()}},payment:{id:'payment1',orderId:'peer-order',amount:'999'}}});await c.accept(payment.raw,payment.headers);
  assert.deepEqual((await f.store.query('SELECT count(*) AS n FROM relay_orders')).rows,before);
  assert.equal(Number((await f.store.query('SELECT count(*) AS n FROM relay_webhooks')).rows[0].n),0);
  const rows=(await f.store.query('SELECT * FROM relay_peer_connection_notifications')).rows;
  assert.equal(rows.length,2);assert.ok(!JSON.stringify(rows).includes('peer-order'));
  // Digests and timestamps may legitimately contain the digits 999. Assert the
  // metadata-only schema, rather than searching unrelated values for an amount.
  for(const row of rows)assert.deepEqual(Object.keys(row).sort(),['digest','event_id','event_type','merchant_id','received_at','test']);
  const restarted=createPeerConnection({connection:settings().liveConnection,store:f.store,fetcher});await restarted.checkIdentity();assert.equal((await restarted.status()).notifications.total,2);assert.deepEqual(await restarted.accept(e.raw,e.headers),{duplicate:true});
 }finally{await f.close();}
});
test('invalid HMAC, stale timestamp, wrong merchant and DB failure do not acknowledge events',async()=>{
 const f=await fixture();try{
  const c=createPeerConnection({connection:settings().liveConnection,store:f.store,fetcher});await c.migrate();await c.checkIdentity();const e=signed();
  await assert.rejects(c.accept(Buffer.concat([e.raw,Buffer.from(' ')]),e.headers),e=>e.status===401);
  await assert.rejects(c.accept(e.raw,{...e.headers,'x-webhook-timestamp':'1000000000'}),e=>e.status===401);
  const wrong=signed('wrong',{data:{order:{id:'other',merchantId:'wrong'}}});await assert.rejects(c.accept(wrong.raw,wrong.headers),e=>e.status===403);
  assert.equal((await c.status()).notifications.total,0);
  const broken=createPeerConnection({connection:settings().liveConnection,store:{...f.store,tx:async()=>{throw Error('database unavailable');}},fetcher});await broken.checkIdentity();await assert.rejects(broken.accept(e.raw,e.headers),/database unavailable/);
  assert.equal((await c.status()).notifications.total,0);await c.accept(e.raw,e.headers);assert.equal((await c.status()).notifications.total,1);
 }finally{await f.close();}
});
test('hosted connection accepts signed events but every checkout stays blocked; operator status stays private',async()=>{
 const f=await fixture();let server;try{
  const cfg=settings(),c=createPeerConnection({connection:cfg.liveConnection,store:f.store,fetcher});await c.migrate();await c.checkIdentity();
  const pay=new Proxy({},{get:()=>()=>assert.fail('No payment provider operation permitted')});
  server=createHostedServer({store:f.store,config:cfg,pay,peerConnection:c,paymentsDisabled:true,allowHttpForTests:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const request=(path,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port:server.address().port,path,method,headers:{host:cfg.host,...headers}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data),headers:res.headers}));});r.on('error',reject);r.end(body);});
  const post=(path,data,headers={})=>request(path,{method:'POST',headers:{origin:cfg.origin,'content-type':'application/json',...headers},body:JSON.stringify(data)});
  assert.equal((await request('/api/operator/peer-connection')).status,403);
  const auth=await post('/api/login',{code:'test-code'}),headers={cookie:auth.headers['set-cookie'][0].split(';')[0]};
  const health=(await request('/healthz')).body;assert.equal(health.liveConnectionMode,'receive_only');assert.equal(health.realPaymentsEnabled,false);assert.equal(health.paymentsDisabled,true);
  for(const route of ['/api/checkouts','/api/checkout-resume','/api/checkout-refresh'])assert.equal((await post(route,{},headers)).status,403);
  assert.equal((await post('/api/webhooks/peer/live',{})).status,401);
  const event=signed();assert.equal((await request('/api/webhooks/peer/live',{method:'POST',headers:event.headers,body:event.raw})).status,202);
  const status=await request('/api/operator/peer-connection',{headers});assert.equal(status.status,200);assert.equal(status.body.notifications.total,1);assert.equal(status.body.liveOrdersEnabled,false);
  assert.equal((await request('/api/state',{headers})).body.orders.length,0);
  const customer=await post('/api/account/signup',{email:'fixture@example.com',password:'SafeTestPassword2026!',name:'Fixture customer',acceptSandbox:true});
  if(customer.status===200){const cookie=customer.headers['set-cookie'][0].split(';')[0];assert.equal((await request('/api/operator/peer-connection',{headers:{cookie}})).status,403);}else assert.fail('Customer fixture signup failed');
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
