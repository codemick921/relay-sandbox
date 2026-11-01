import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {fixture} from './fixtures/account-store.mjs';
import {local,remote,payment,rpc} from './fixtures/live-evidence.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createLiveStore} from '../hosted/live-store.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createRampSimulation} from '../hosted/ramp-simulation.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {verifyPayDelivery} from '../server/pay-delivery.mjs';
import {historyOptions,renderStatement,summarize} from '../hosted/funding-history.mjs';
const owner='customer:'+randomUUID(),other='customer:'+randomUUID();
async function setup(){const f=await fixture();f.live=createLiveStore(f.pool,{merchantId:'merchant-history'});f.sim=createLiveStore(f.pool,{merchantId:'fixture-history'});await f.live.migrate();await createFundingDrafts(f.store).migrate();f.scopes=[{merchantId:'merchant-history',simulated:false},{merchantId:'fixture-history',simulated:true}];return f;}
async function insert(f,{who=owner,store=f.live,at='2026-10-24T12:00:00Z',name='Research agent',received=false,fiat=null}={}){
 const o={...local(),id:randomUUID(),providerOrderId:randomUUID(),merchantId:store.historyScope.merchantId,requestedUsdcAmount:'12.5',agent:{...local().agent,id:randomUUID(),network:'Base',token:'USDC',name}};
 await store.bindTrustedOrder(who,o);let v={};
 if(received){const p={...payment(),orderId:o.providerOrderId},remoteOrder={...remote(),id:o.providerOrderId,merchantId:o.merchantId,notes:{relayOrderId:o.id}};v=await verifyPayDelivery(o,remoteOrder,[p],{rpc:rpc()});if(fiat)v.verification.payIn={settlement:fiat};}
 await f.store.query('UPDATE relay_live_orders SET created_at=$2,status=$3,result=$4 WHERE id=$1',[o.id,at,v.status??'checkout_ready',{...v,checkoutUrl:'SECRET-URL',private:'PRIVATE-DIAGNOSTIC'}]);return o;
}

test('history covers more than 100 rows, pins owner and merchant, paginates stable equal timestamps',async()=>{
 const f=await setup();try{
  const ids=[];for(let i=0;i<526;i++)ids.push((await insert(f)).id);
  await insert(f,{who:other});const unconfigured=createLiveStore(f.pool,{merchantId:'not-authorised'});await insert(f,{store:unconfigured});
  const all=[];for(let page=1;page<=22;page++){const data=await f.store.fundingHistory(owner,{page},f.scopes);assert.equal(data.total,526);assert.equal(data.summary.requestedGbp.amount,'13150.00');all.push(...data.records.map(r=>r.id));}
  assert.equal(new Set(all).size,526);assert.deepEqual(new Set(all),new Set(ids));
  const old=await f.store.fundingHistory(owner,{},f.scopes,{id:ids[0]});assert.equal(old.records[0].id,ids[0]);
  const foreign=await insert(f,{who:other});await assert.rejects(()=>f.store.fundingHistory(owner,{},f.scopes,{id:foreign.id}),e=>e.status===404);
  const before=await f.store.query('SELECT id,status,result,generation,next_check_at FROM relay_live_orders ORDER BY id');
  const downloaded=await f.store.fundingHistory(owner,{},f.scopes,{download:true});assert.equal(downloaded.records.length,526);
  assert.deepEqual((await f.store.query('SELECT id,status,result,generation,next_check_at FROM relay_live_orders ORDER BY id')).rows,before.rows);
  for(const s of ['SECRET-URL','PRIVATE-DIAGNOSTIC','merchant-history'])assert.ok(!JSON.stringify(downloaded).includes(s));
 }finally{await f.close();}
});

test('search, address, status and London creation dates use saved destination and DST boundaries',async()=>{
 const f=await setup();try{
  await insert(f,{at:'2026-09-30T22:59:59Z',name:'Before October'});
  const first=await insert(f,{at:'2026-09-30T23:00:00Z',name:'Old wallet name'});
  await insert(f,{at:'2026-10-31T23:59:59Z',name:'Month end'});
  await insert(f,{at:'2026-11-01T00:00:00Z',name:'November'});
  const a=await f.store.fundingHistory(owner,{from:'2026-10-01',to:'2026-10-31'},f.scopes);assert.equal(a.total,2);
  assert.equal((await f.store.fundingHistory(owner,{q:'OLD wallet'},f.scopes)).total,1);
  assert.equal((await f.store.fundingHistory(owner,{q:first.id},f.scopes)).total,1);
  assert.equal((await f.store.fundingHistory(owner,{q:'%'},f.scopes)).total,0);
  assert.equal((await f.store.fundingHistory(owner,{address:'0x'+'2'.repeat(40)},f.scopes)).total,0);
  assert.equal((await f.store.fundingHistory(owner,{status:'received'},f.scopes)).total,0);
 }finally{await f.close();}
});

test('drafts merge once, stopped late deliveries retain receipts and simulations stay separate',async()=>{
 const f=await setup();try{
  const o=await insert(f,{received:true,fiat:{paymentAmount:'20.40',currency:'GBP'}});
  await f.store.query("INSERT INTO relay_funding_drafts(id,owner,request_id,agent_id,agent_revision,agent,pence,status,merchant_id,attempt_token,attempted_at,provider_id,requested_usdc,stopped_at) VALUES($1,$2,$3,$4,1,$5,2500,'bound','merchant-history',$6,now(),$7,'12.5',now())",[o.id,owner,randomUUID(),o.agent.id,o.agent,randomUUID(),o.providerOrderId]);
  await insert(f,{store:f.sim,received:true});
  await f.store.query("INSERT INTO relay_funding_drafts(id,owner,request_id,agent_id,agent_revision,agent,pence,status) VALUES($1,$2,$3,$4,1,$5,500,'cancelled')",[randomUUID(),owner,randomUUID(),o.agent.id,o.agent]);
  const live=await f.store.fundingHistory(owner,{},f.scopes);assert.equal(live.total,2);assert.equal(live.summary.confirmedUsdc.amount,'12.000000');assert.equal(live.summary.confirmedUsdc.missing,1);assert.equal(live.summary.recordedFiat.GBP.amount,'20.40');
  const r=live.records.find(r=>r.id===o.id);assert.equal(r.stopped,true);assert.equal(r.document,'receipt');assert.equal(r.code,'received');
  const sim=await f.store.fundingHistory(owner,{source:'simulated'},f.scopes);assert.equal(sim.total,1);assert.equal(sim.records[0].simulated,true);
  const all=await f.store.fundingHistory(owner,{source:'all'},f.scopes);assert.equal(all.total,3);assert.equal(all.summary,null);
  await assert.rejects(()=>f.store.fundingHistory(owner,{source:'all'},f.scopes,{download:true}),e=>e.status===400);
 }finally{await f.close();}
});

test('known amounts use exact decimals, currencies stay separate and missing values do not become zero',()=>{
 const records=[{requestedGbp:'0.10',netUsdc:'0.100001',confirmedUsdc:null,peerFeeUsdc:'0.000000',recordedFiat:'0.1 GBP'},{requestedGbp:'0.20',netUsdc:'0.200002',confirmedUsdc:null,peerFeeUsdc:null,recordedFiat:'1.23 USD'}];
 const s=summarize(records);assert.equal(s.requestedGbp.amount,'0.30');assert.equal(s.netUsdc.amount,'0.300003');assert.deepEqual(s.confirmedUsdc,{amount:null,known:0,missing:2});assert.equal(s.peerFeeUsdc.amount,'0.000000');assert.equal(s.peerFeeUsdc.missing,1);assert.equal(s.recordedFiat.GBP.amount,'0.10');assert.equal(s.recordedFiat.USD.amount,'1.23');
});

test('statement exports escape untrusted text and expose no private evidence; Ramp and legacy sandbox remain test records',async()=>{
 const f=await setup();try{
  await insert(f,{store:f.sim,name:' =HYPERLINK("bad")<script>bad</script>',received:true});
  const o=local(),id=randomUUID();await f.store.query('INSERT INTO relay_orders(id,owner,request_id,request,status) VALUES($1,$2,$3,$4,$5)',[id,owner,randomUUID(),{...o,source:'sandbox'},'sandbox_complete']);
  const ramp=createRampSimulation(f.store);await ramp.migrate();await f.store.query('INSERT INTO relay_ramp_simulations(id,owner,request_id,agent,pence,expected_raw,fee_pence) VALUES($1,$2,$3,$4,500,$5,10)',[randomUUID(),owner,randomUUID(),o.agent,'1000000']);
  const data=await f.store.fundingHistory(owner,{source:'simulated'},f.scopes,{download:true});assert.equal(data.total,3);
  const html=renderStatement(data,'html'),csv=renderStatement(data,'csv');assert.match(html,/SIMULATED/);assert.match(html,/&lt;script&gt;/);assert.ok(!html.includes('<script>'));assert.match(csv,/"' =HYPERLINK/);assert.ok(!html.includes('SECRET-URL'));assert.match(html,/Europe\/London/);assert.match(html,/not a statement of transfers/);
  assert.equal(data.records.find(r=>r.provider==='Ramp').deliveryConfirmed,false);
 }finally{await f.close();}
});

test('filters reject malformed dates, unexpected access scope and duplicate keys',()=>{
 for(const q of ['from=2026-02-30','from=2026-11-01&to=2026-01-01','page=0','page=1.2','page=2&page=3','merchantId=foreign','owner=foreign','source=anything','address=invalid','q='+('a'.repeat(129))])assert.throws(()=>historyOptions(new URLSearchParams(q)));
});

test('history HTTP requires customer session, refuses cross-origin and POST, and retrieves older receipt without provider calls',async()=>{
 const f=await setup();let server;try{
  const accounts=createAccounts(f.store),a=await accounts.signup({email:'history@example.test',name:'History tester',password:'correct horse meadow lantern',acceptSandbox:true}),b=await accounts.signup({email:'other@example.test',name:'Other tester',password:'correct horse meadow lantern',acceptSandbox:true});
  const who='customer:'+a.account.id,o=await insert(f,{who,store:f.sim,received:true});
  let calls=0;const forbidden=()=>{calls++;throw Error('No provider calls');};
  server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},allowHttpForTests:true,paymentsDisabled:true,tracking:{simulated:true,store:f.sim},pay:{readiness:forbidden}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const req=(path,{token=a.token,method='GET',origin='https://relay.example',site='same-origin'}={})=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:'relay.example',origin,'sec-fetch-site':site,'content-type':'application/json',cookie:token?'__Host-relay_sandbox='+token:''}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});r.on('error',reject);r.end(method==='POST'?'{}':undefined);});
  const path='/api/funding-history/'+o.id;
  assert.equal((await req(path,{token:null})).status,401);assert.equal((await req(path,{token:b.token})).status,404);assert.equal((await req(path,{site:'cross-site'})).status,403);assert.equal((await req(path,{origin:'https://evil.example'})).status,403);assert.equal((await req(path,{method:'POST'})).status,405);
  assert.equal((await req(path)).status,200);
  const list=await req('/api/funding-history?source=simulated');assert.equal(JSON.parse(list.body).total,1);assert.equal(list.headers['cache-control'],'no-store');
  const record=await req(`/api/payment-records/${o.id}/download?format=html`);assert.equal(record.status,200);assert.match(record.body,/12.000000/);
  const exported=await req('/api/funding-history/download?source=simulated&format=csv');assert.equal(exported.status,200);assert.match(exported.headers['content-disposition'],/eupova-simulated-statement/);assert.match(exported.body,/SIMULATED/);assert.equal(calls,0);
  await accounts.logout(a.token);assert.equal((await req(path)).status,401);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});

test('oversized downloads fail explicitly rather than silently truncating the statement',async()=>{
 const f=await setup();try{
  const o=await insert(f);await f.store.query(`INSERT INTO relay_live_orders(id,owner,merchant_id,provider_id,request)
   SELECT id,$1,'merchant-history','bulk-'||g,$2::jsonb||jsonb_build_object('id',id,'providerOrderId','bulk-'||g) FROM (SELECT gen_random_uuid() AS id,g FROM generate_series(1,10000) g) batch`,[owner,o]);
  await assert.rejects(()=>f.store.fundingHistory(owner,{},f.scopes,{download:true}),e=>e.status===413&&e.message.includes('shorter date range'));
  const page=await f.store.fundingHistory(owner,{page:401},f.scopes);assert.equal(page.total,10001);assert.equal(page.records.length,1);
 }finally{await f.close();}
});

test('Payments in-progress filter applies across pages without changing any saved records',async()=>{
 const f=await setup();try{
  const waiting=[];for(let i=0;i<27;i++)waiting.push(await insert(f,{name:'Waiting '+i}));
  const received=await insert(f,{received:true,name:'Confirmed'});
  await insert(f,{who:other});await insert(f,{store:f.sim});
  const snapshot=async()=>({orders:(await f.store.query('SELECT * FROM relay_live_orders ORDER BY id')).rows,drafts:(await f.store.query('SELECT * FROM relay_funding_drafts ORDER BY id')).rows});
  const before=await snapshot(),first=await f.store.fundingHistory(owner,{status:'in_progress'},f.scopes),second=await f.store.fundingHistory(owner,{status:'in_progress',page:2},f.scopes);
  assert.equal(first.total,27);assert.equal(first.records.length,25);assert.equal(second.records.length,2);
  assert.deepEqual(new Set([...first.records,...second.records].map(r=>r.id)),new Set(waiting.map(o=>o.id)));
  const completed=await f.store.fundingHistory(owner,{status:'received'},f.scopes);assert.equal(completed.total,1);assert.equal(completed.records[0].id,received.id);
  assert.deepEqual(await snapshot(),before);
 }finally{await f.close();}
});


test('owned payment detail and receipt read archived offers without mutating any saved rows',async()=>{
 const {offer}=await import('./fixtures/cost-comparison.mjs');
 const f=await setup();try{
  const o=await insert(f,{received:true}),otherOrder=await insert(f,{who:other,received:true});
  const at=new Date(Date.now()-60000).toISOString(),expires=new Date(Date.now()+60000).toISOString();
  const e=offer(o,{checkedAt:at,expiresAt:expires});
  await f.store.query("INSERT INTO relay_live_audit(order_id,event,data) VALUES($1,'payin_observed',$2)",[o.id,{...e,private:'SECRET-AUDIT',checkoutUrl:'SECRET-CHECKOUT'}]);
  await f.store.query("INSERT INTO relay_live_audit(order_id,event,data) VALUES($1,'payin_observed',$2)",[otherOrder.id,{...e,providerOrderId:otherOrder.providerOrderId,totalPence:999}]);
  const snapshot=async()=>({orders:(await f.store.query('SELECT * FROM relay_live_orders ORDER BY id')).rows,audit:(await f.store.query('SELECT * FROM relay_live_audit ORDER BY id')).rows});
  const before=await snapshot(),data=await f.store.fundingHistory(owner,{},f.scopes,{id:o.id}),r=data.records[0];
  assert.equal(r.costComparison.status,'different');assert.equal(r.costComparison.offer.pay,'25.00 GBP');assert.equal(r.costComparison.differenceUsdc,'0.118750');
  const {renderRecord}=await import('../hosted/payment-records.mjs');
  for(const output of [JSON.stringify(data),renderRecord(r,'html'),renderRecord(r,'csv')]){assert.ok(!output.includes('SECRET-AUDIT'));assert.ok(!output.includes('SECRET-CHECKOUT'));assert.ok(!output.includes(otherOrder.id));}
  await assert.rejects(()=>f.store.fundingHistory(other,{},f.scopes,{id:o.id}),e=>e.status===404);
  assert.deepEqual(await snapshot(),before);
 }finally{await f.close();}
});
