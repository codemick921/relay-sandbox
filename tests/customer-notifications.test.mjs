import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {fixture} from './fixtures/account-store.mjs';
import {createCustomerNotifications,nextReminder,londonDay} from '../hosted/customer-notifications.mjs';
import {createLiveStore} from '../hosted/live-store.mjs';
import {createWalletBalances} from '../hosted/wallet-balances.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {local,remote,payment,rpc} from './fixtures/live-evidence.mjs';
import {verifyPayDelivery} from '../server/pay-delivery.mjs';
const owner='customer:'+randomUUID(),other='customer:'+randomUUID();
async function setup(){const f=await fixture();f.now=Date.parse('2026-10-25T12:00:00Z');f.live=createLiveStore(f.pool,{merchantId:'notice-live'});await f.live.migrate();f.n=createCustomerNotifications(f.store,{scopes:[{merchantId:'notice-live'}],clock:()=>f.now});f.advance=()=>{f.now+=31000;};return f;}
async function order(f,who=owner,received=true,merchant='notice-live'){
 const o={...local(),id:randomUUID(),providerOrderId:randomUUID(),merchantId:merchant,requestedUsdcAmount:'12.5',agent:{...local().agent,id:randomUUID(),network:'Base',token:'USDC'}};const live=createLiveStore(f.pool,{merchantId:merchant});await live.bindTrustedOrder(who,o);
 const v=received?await verifyPayDelivery(o,{...remote(),id:o.providerOrderId,merchantId:merchant,notes:{relayOrderId:o.id}},[{...payment(),orderId:o.providerOrderId}],{rpc:rpc()}):{};
 await f.store.query('UPDATE relay_live_orders SET status=$2,result=$3 WHERE id=$1',[o.id,v.status??'checkout_ready',{...v,checkoutUrl:'SECRET-CHECKOUT',private:'SECRET-DIAGNOSTIC'}]);return o;
}
async function agent(f,who=owner){const a={...local().agent,id:randomUUID(),name:'Research agent',network:'Base',token:'USDC'};await f.store.addAgent(who,a);return a;}
test('calendar uses London days, preserves month end and catches up without a backlog',()=>{
 assert.equal(londonDay(Date.parse('2026-07-01T23:30:00Z')),'2026-07-02');assert.equal(londonDay(Date.parse('2026-10-25T00:30:00Z')),'2026-10-25');
 assert.equal(nextReminder('2028-01-31','monthly','2028-02-01'),'2028-02-29');assert.equal(nextReminder('2028-01-31','monthly','2028-02-29'),'2028-03-31');assert.equal(nextReminder('2026-01-01','weekly','2026-10-25'),'2026-10-29');assert.throws(()=>nextReminder('2026-02-30','monthly','2026-03-01'));
});
test('notices isolate owner and merchant, deduplicate concurrent checks and never change payment evidence',async()=>{const f=await setup();try{
 await order(f);await order(f,other);await order(f,owner,true,'foreign');const before=(await f.store.query('SELECT * FROM relay_live_orders ORDER BY id')).rows;
 await Promise.all([f.n.sync(owner),f.n.sync(owner)]);let d=await f.n.list(owner);assert.equal(d.total,1);assert.equal(d.items[0].kind,'arrival');assert.equal(d.items[0].simulated,false);assert.match(d.items[0].data.message,/12.000000 USDC/);
 f.advance();await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,1);assert.deepEqual((await f.store.query('SELECT * FROM relay_live_orders ORDER BY id')).rows,before);assert.ok(!JSON.stringify(d).includes('SECRET'));assert.equal((await f.n.list(other)).total,0);
 await assert.rejects(()=>f.n.read(other,{id:d.items[0].id,read:true}),e=>e.status===404);await f.n.read(owner,{id:d.items[0].id,read:true});assert.equal((await f.n.list(owner)).unread,0);await f.n.read(owner,{id:d.items[0].id,read:false});assert.equal((await f.n.list(owner)).unread,1);await f.n.read(owner,{all:true});assert.equal((await f.n.list(owner)).unread,0);
 await f.store.migrate();assert.equal((await f.n.list(owner)).total,1);
 }finally{await f.close();}});
test('unverified received status is never an arrival and simulation evidence cannot be labelled real',async()=>{const f=await setup();try{
 const o=await order(f,owner,false);await f.store.query("UPDATE relay_live_orders SET status='checkout_received' WHERE id=$1",[o.id]);await f.n.sync(owner);assert.ok((await f.n.list(owner)).items.every(n=>n.kind!=='arrival'));
 const sim=await order(f);await f.store.query("UPDATE relay_live_orders SET result=jsonb_set(result,'{verification,simulated}','true'::jsonb) WHERE id=$1",[sim.id]);f.advance();await f.n.sync(owner);assert.ok(!(await f.n.list(owner)).items.some(n=>n.data.requestId===sim.id));
 await f.n.preferences(owner,{payments:true,balances:true,simulations:true});const sim2=await order(f);await f.store.query("UPDATE relay_live_orders SET result=jsonb_set(result,'{verification,simulated}','true'::jsonb) WHERE id=$1",[sim2.id]);await f.n.sync(owner);const n=(await f.n.list(owner)).items.find(n=>n.data.requestId===sim2.id);assert.equal(n.simulated,true);assert.equal(n.data.title,'Simulated funds arrived');
 }finally{await f.close();}});
test('attention notices repeat only after a real state transition',async()=>{const f=await setup();try{
 const o=await order(f,owner,false);await f.store.query('UPDATE relay_live_orders SET review_required=true WHERE id=$1',[o.id]);await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,1);f.advance();await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,1);
 await f.store.query('UPDATE relay_live_orders SET review_required=false WHERE id=$1',[o.id]);f.advance();await f.n.sync(owner);await f.store.query('UPDATE relay_live_orders SET review_required=true WHERE id=$1',[o.id]);f.advance();await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,2);
 }finally{await f.close();}});
test('low balance alerts require fresh matching evidence and stale checks do not reset the low episode',async()=>{const f=await setup();try{
 const a=await agent(f),b=createWalletBalances(f.store,{rpc:{}});await b.migrate();await b.state(owner);
 const set=async(amount,at=f.now,failed=false)=>f.store.query('UPDATE relay_wallet_balances SET amount_raw=$2,observed_at=$3,failed=$4,alerts_enabled=true WHERE agent_id=$1',[a.id,amount,new Date(at),failed]);
 await set('1000000',f.now-200000);await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,0);f.advance();await set('1000000');await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,1);
 f.advance();await set(null,f.now,true);await f.n.sync(owner);f.advance();await set('1000000');await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,1);
 f.advance();await set('20000000');await f.n.sync(owner);f.advance();await set('1000000');await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,2);
 f.advance();await f.store.query("UPDATE relay_wallet_balances SET address_key='different' WHERE agent_id=$1",[a.id]);await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,2);
 }finally{await f.close();}});
test('reminders are owned, optional, catch up once and never create orders',async()=>{const f=await setup();try{
 const a=await agent(f),foreign=await agent(f,other),body={agentId:a.id,enabled:true,frequency:'monthly',startDate:'2026-10-25'};
 await assert.rejects(()=>f.n.reminder(owner,{...body,agentId:foreign.id}),e=>e.status===404);await assert.rejects(()=>f.n.reminder(owner,{...body,startDate:'2026-10-24'}));
 await f.n.reminder(owner,body);await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,1);assert.equal((await f.n.list(owner)).reminders[0].next_due,'2026-11-25');
 f.now=Date.parse('2027-03-28T12:00:00Z');await f.n.sync(owner);let d=await f.n.list(owner);assert.equal(d.total,2);assert.equal(d.reminders[0].next_due,'2027-04-25');await f.n.reminder(owner,{...body,enabled:false});f.now+=90*86400000;await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,2);assert.equal(Number((await f.store.query('SELECT count(*) FROM relay_live_orders')).rows[0].count),0);
 }finally{await f.close();}});
test('pagination and invalid input are bounded and notification preferences suppress new events',async()=>{const f=await setup();try{
 await f.n.preferences(owner,{payments:false,balances:true,simulations:false});await order(f);await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,0);
 await f.n.preferences(owner,{payments:true,balances:true,simulations:false});for(let i=0;i<26;i++)await order(f);await f.n.sync(owner);assert.equal((await f.n.list(owner)).items.length,25);assert.equal((await f.n.list(owner,new URLSearchParams('page=2'))).items.length,1);
 for(const q of ['owner=other','page=0','page=2&page=3','filter=bad'])await assert.rejects(()=>f.n.list(owner,new URLSearchParams(q)));await assert.rejects(()=>f.n.preferences(owner,{payments:true,balances:true,simulations:false,owner:other}));await assert.rejects(()=>f.n.list('owner'),e=>e.status===403);
 }finally{await f.close();}});
test('HTTP requires a customer session and same origin; notification actions make no provider calls',async()=>{const f=await setup();let server;try{
 const accounts=createAccounts(f.store),a=await accounts.signup({email:'notices@example.test',name:'Notification tester',password:'correct horse meadow lantern',acceptSandbox:true});let calls=0;const forbidden=()=>{calls++;throw Error('Provider call forbidden');};
 server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},allowHttpForTests:true,paymentsDisabled:true,tracking:{store:f.live,simulated:true},pay:{readiness:forbidden}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const req=(path,{token=a.token,method='GET',origin='https://relay.example',body={}}={})=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:'relay.example',origin,'sec-fetch-site':'same-origin','content-type':'application/json',cookie:token?'__Host-relay_sandbox='+token:''}},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve({status:res.statusCode,data,headers:res.headers}));});r.on('error',reject);r.end(method==='POST'?JSON.stringify(body):undefined);});
 assert.equal((await req('/api/notifications',{token:null})).status,401);assert.equal((await req('/api/notifications',{origin:'https://evil.example'})).status,403);assert.equal((await req('/api/notifications/sync',{method:'POST',body:{owner}})).status,400);assert.equal((await req('/api/notifications/sync',{method:'POST'})).status,200);assert.equal((await req('/api/notifications')).headers['cache-control'],'no-store');assert.equal(calls,0);await accounts.logout(a.token);assert.equal((await req('/api/notifications')).status,401);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}});
test('disputes and unavailable checks take priority over historical arrival evidence',async()=>{const f=await setup();try{
 const o=await order(f);await f.store.query("UPDATE relay_live_orders SET result=result||'{\"chargebackStatus\":\"CHARGEBACKED\"}'::jsonb WHERE id=$1",[o.id]);await f.n.sync(owner);const n=(await f.n.list(owner)).items[0];assert.equal(n.kind,'attention');assert.equal(n.data.title,'Payment dispute recorded');
 const o2=await order(f);await f.store.query("UPDATE relay_live_orders SET result=result||'{\"trackingError\":true}'::jsonb WHERE id=$1",[o2.id]);f.advance();await f.n.sync(owner);assert.equal((await f.n.list(owner)).items.find(n=>n.data.requestId===o2.id).data.title,'Tracking check unavailable');
 }finally{await f.close();}});
test('saving an unchanged due reminder retains its original monthly anchor and does not resend',async()=>{const f=await setup();try{
 const a=await agent(f);f.now=Date.parse('2026-01-31T12:00:00Z');const body={agentId:a.id,enabled:true,frequency:'monthly',startDate:'2026-01-31'};await f.n.reminder(owner,body);await f.n.sync(owner);assert.equal((await f.n.list(owner)).reminders[0].next_due,'2026-02-28');
 f.now=Date.parse('2026-02-28T12:00:00Z');await f.n.reminder(owner,body);await f.n.sync(owner);const d=await f.n.list(owner);assert.equal(d.total,2);assert.equal(d.reminders[0].next_due,'2026-03-31');await f.n.reminder(owner,body);f.advance();await f.n.sync(owner);assert.equal((await f.n.list(owner)).total,2);
 }finally{await f.close();}});
