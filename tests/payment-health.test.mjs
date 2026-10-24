import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {local,remote,payment,rpc} from './fixtures/live-evidence.mjs';
import {createLiveStore} from '../hosted/live-store.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {config} from '../hosted/config.mjs';
import {digest} from '../hosted/db.mjs';
import {healthOptions} from '../hosted/payment-health.mjs';
import {verifyPayDelivery} from '../server/pay-delivery.mjs';

async function setup(){const f=await fixture(),live=createLiveStore(f.pool,{merchantId:'merchant-one'}),other=createLiveStore(f.pool,{merchantId:'merchant-two'});await live.migrate();return {...f,live,other};}
async function order(f,{owner='private-owner',merchantId='merchant-one',status='checkout_ready',result={}}={}){
 const o={...local(),id:randomUUID(),providerOrderId:'order-'+randomUUID(),merchantId,requestedUsdcAmount:'12.5',agent:{...local().agent,id:randomUUID(),network:'Base',token:'USDC'}};
 await (merchantId==='merchant-one'?f.live:f.other).bindTrustedOrder(owner,o);
 await f.store.query('UPDATE relay_live_orders SET status=$2,result=$3 WHERE id=$1',[o.id,status,result]);return o;
}

test('admin role defaults off and only explicit configured tester labels qualify',()=>{
 const env={RELAY_MODE:'sandbox',PUBLIC_ORIGIN:'https://relay.example',DATABASE_URL:'postgresql://example',SANDBOX_TESTERS:JSON.stringify([{label:'admin',sha256hex:digest('code')}])};
 assert.deepEqual(config(env).paymentHealthAdmins,[]);
 assert.deepEqual(config({...env,RELAY_PAYMENT_HEALTH_ADMINS:'["admin"]'}).paymentHealthAdmins,['admin']);
 for(const value of ['["customer:any"]','["admin","admin"]','"admin"','null','["*"]','bad'])assert.throws(()=>config({...env,RELAY_PAYMENT_HEALTH_ADMINS:value}));
 assert.equal(config(env).livePayments,false);assert.equal(config(env).liveConnection,null);
});

test('read filters are bounded and reject unsupported, repeated or injected parameters',()=>{
 assert.deepEqual(healthOptions(new URLSearchParams()),{source:'live',filter:'attention',page:1,id:null});
 for(const q of ['source=other','filter=DROP','page=-1','page=0','page=100001','page=1.5','id=no','merchantId=merchant-two','source=live&source=simulated'])assert.throws(()=>healthOptions(new URLSearchParams(q)));
});

test('saved read is merchant scoped, counts all rows, paginates stably and excludes private payloads',async()=>{
 const f=await setup();try{
  const ids=[];for(let i=0;i<27;i++)ids.push((await order(f)).id);
  const hidden=await order(f,{merchantId:'merchant-two',status:'checkout_review'});
  await f.store.query("UPDATE relay_live_orders SET result=$2,status='checkout_review',review_required=true,attempts=2,next_check_at=now()-interval '20 minutes' WHERE id=$1",[ids[0],{trackingError:'PRIVATE DIAGNOSTIC',checkoutUrl:'SECRET TOKEN',email:'PRIVATE EMAIL'}]);
  await f.store.query("INSERT INTO relay_live_audit(order_id,event,data) VALUES($1,'operator_review_resolved',$2)",[ids[0],{reason:'PRIVATE REASON',token:'SECRET TOKEN'}]);
  const first=await f.live.paymentHealth({filter:'all'}),second=await f.live.paymentHealth({filter:'all',page:2});
  assert.equal(first.counts.all,27);assert.equal(first.counts.review,1);assert.equal(first.counts.retry,1);assert.equal(first.counts.overdue,1);assert.equal(first.counts.attention,1);
  assert.equal(first.records.length,25);assert.equal(second.records.length,2);assert.equal(new Set([...first.records,...second.records].map(x=>x.record.id)).size,27);
  const detail=await f.live.paymentHealth({id:ids[0]});assert.equal(detail.records.length,1);assert.ok(detail.detail.timeline.some(x=>x.label==='Earlier review resolved'));
  assert.equal(detail.detail.record.document,'summary');assert.equal(detail.worker.status,'unknown');assert.equal(detail.notifications.total,0);
  const json=JSON.stringify(detail);for(const value of ['PRIVATE','SECRET',hidden.id,'private-owner','checkoutUrl','digest'])assert.ok(!json.includes(value));
  await assert.rejects(()=>f.live.paymentHealth({id:hidden.id}),e=>e.status===404);
  await assert.rejects(()=>f.live.paymentHealth({filter:'review; DELETE'}));
 }finally{await f.close();}
});

test('heartbeat, inbox backlog, stopped settlement and finality are distinct saved evidence',async()=>{
 const f=await setup();try{
  await createFundingDrafts(f.store).migrate();const o=await order(f),v=await verifyPayDelivery(o,{...remote(),merchantId:o.merchantId,id:o.providerOrderId,notes:{relayOrderId:o.id}},[{...payment(),orderId:o.providerOrderId}],{rpc:rpc()});
  await f.store.query('UPDATE relay_live_orders SET result=$2,status=$3 WHERE id=$1',[o.id,v,v.status]);
  await f.store.query("INSERT INTO relay_funding_drafts(id,owner,request_id,agent_id,agent_revision,agent,pence,status,merchant_id,attempt_token,attempted_at,provider_id,requested_usdc,stopped_at) VALUES($1,'private-owner',$2,$3,1,$4,2500,'bound','merchant-one',$5,now(),$6,'12.5',now())",[o.id,randomUUID(),o.agent.id,o.agent,randomUUID(),o.providerOrderId]);
  await f.live.heartbeat('worker');await f.other.heartbeat('other-worker');
  await f.live.accept({environment:'LIVE',merchantId:'merchant-one',eventId:'event1',digest:'a'.repeat(64),deliveryId:'delivery1',orderId:o.providerOrderId,type:'order.updated'});
  await f.live.accept({environment:'LIVE',merchantId:'merchant-one',eventId:'event2',digest:'b'.repeat(64),deliveryId:'delivery2',orderId:'outside-relay',type:'order.updated'},{matchedOnly:true});
  const result=await f.live.paymentHealth({id:o.id,simulated:true});assert.equal(result.counts.stopped_funds,1);assert.equal(result.worker.status,'recent');assert.equal(result.notifications.pending,1);assert.equal(result.notifications.unmatched,1);assert.ok(result.notifications.oldestPendingAt);
  assert.equal(result.detail.record.deliveryConfirmed,true);assert.equal(result.detail.record.simulated,true);assert.equal(result.detail.record.confirmedUsdc,'12.000000');
  await f.store.query("UPDATE relay_live_workers SET beat_at=now()-interval '5 minutes' WHERE merchant_id='merchant-one'");
  await f.store.query("UPDATE relay_live_orders SET result=result-'delivery' WHERE id=$1",[o.id]);
  const changed=await f.live.paymentHealth({id:o.id});assert.equal(changed.worker.status,'stale');assert.equal(changed.detail.record.deliveryConfirmed,false);assert.equal(changed.detail.record.document,'summary');
 }finally{await f.close();}
});

test('admin HTTP is GET-only, explicit, revocable, same-origin and never calls providers or changes evidence',async()=>{
 const f=await setup();let server;try{
  const o=await order(f),testers=['admin','ordinary'].map(label=>({label,sha256hex:digest(label)}));
  const settings={origin:'https://relay.example',host:'relay.example',testers,paymentHealthAdmins:['admin']};
  for(const t of testers)await f.store.login(digest(t.label+'-token'),t);
  const accounts=createAccounts(f.store),customer=await accounts.signup({email:'admin@example.test',name:'admin',password:'correct horse meadow lantern',acceptSandbox:true});
  let calls=0;const forbidden=async()=>{calls++;throw Error('No provider calls');};
  server=createHostedServer({store:f.store,config:settings,allowHttpForTests:true,paymentsDisabled:true,tracking:{simulated:true,store:f.live},pay:{readiness:forbidden,refresh:forbidden,create:forbidden}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const req=(path,{token=digest('admin-token'),method='GET',site='same-origin',origin=settings.origin}={})=>new Promise((resolve,reject)=>{const request=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:settings.host,origin,'sec-fetch-site':site,cookie:token?'__Host-relay_sandbox='+token:''}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(body)}));});request.on('error',reject);request.end();});
  const path='/api/operator/payment-health?source=simulated&id='+o.id;
  for(const token of ['',customer.token,digest('ordinary-token')])assert.equal((await req(path,{token})).status,403);
  for(const method of ['POST','PUT','DELETE'])assert.equal((await req(path,{method})).status,405);
  assert.equal((await req(path,{site:'cross-site'})).status,403);assert.equal((await req(path,{origin:'https://other.example'})).status,403);
  const before=await f.store.query('SELECT * FROM relay_live_orders ORDER BY id'),auditBefore=await f.store.query('SELECT * FROM relay_live_audit ORDER BY id');
  const result=await req(path);assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.data.detail.record.id,o.id);assert.equal(result.data.simulated,true);
  assert.equal((await req('/api/operator/payment-health')).data.available,false);
  assert.equal((await req('/api/state')).data.adminPaymentHealth,true);assert.equal((await req('/api/state',{token:customer.token})).data.adminPaymentHealth,false);assert.equal((await req('/api/state',{token:digest('ordinary-token')})).data.adminPaymentHealth,false);
  assert.equal(calls,0);assert.deepEqual((await f.store.query('SELECT * FROM relay_live_orders ORDER BY id')).rows,before.rows);assert.deepEqual((await f.store.query('SELECT * FROM relay_live_audit ORDER BY id')).rows,auditBefore.rows);
  settings.paymentHealthAdmins=[];assert.equal((await req(path)).status,403);settings.paymentHealthAdmins=['admin'];await f.store.logout(digest('admin-token'));assert.equal((await req(path)).status,403);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});

test('timeline is bounded and unknown events never expose their raw contents',async()=>{
 const f=await setup();try{const o=await order(f);await f.store.query("INSERT INTO relay_live_audit(order_id,event,data) SELECT $1,'PRIVATE UNKNOWN EVENT','{\"secret\":\"PRIVATE DATA\"}'::jsonb FROM generate_series(1,105)",[o.id]);const result=await f.live.paymentHealth({id:o.id});assert.equal(result.detail.timeline.length,100);assert.equal(result.detail.timelineTruncated,true);assert.ok(!JSON.stringify(result).includes('PRIVATE'));}finally{await f.close();}
});

test('partial and completed orders have different overdue rules and reject merchant overrides',async()=>{
 const f=await setup();try{
  const partial=await order(f,{status:'checkout_partial'}),completed=await order(f,{status:'checkout_received'});
  await f.store.query("UPDATE relay_live_orders SET next_check_at=now()-interval '20 minutes'");
  const summary=await f.live.paymentHealth({filter:'overdue'});assert.equal(summary.counts.partial,1);assert.equal(summary.counts.overdue,1);assert.equal(summary.records[0].record.id,partial.id);assert.ok(!summary.records.some(r=>r.record.id===completed.id));
  // A reader receives only a server-pinned merchant. It cannot select one from query input.
  assert.throws(()=>healthOptions(new URLSearchParams('merchantId=merchant-two')));
 }finally{await f.close();}
});
