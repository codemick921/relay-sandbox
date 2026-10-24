import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import http from 'node:http';
import {createHostedServer} from '../hosted/server.mjs';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createRestrictedTestPolicy} from '../hosted/restricted-test.mjs';
import {createRevolutPolicy,createRevolutRelease} from '../hosted/revolut-test.mjs';
import {createRevolutOperator} from '../hosted/revolut-operator.mjs';
import {createLiveStore} from '../hosted/live-store.mjs';
import {createLiveReadService} from '../server/pay-readonly.mjs';
import {fundingPence} from '../server/funding-amount.mjs';
import {remote,payment,rpc} from './fixtures/live-evidence.mjs';
const envelope=x=>new Response(JSON.stringify({success:true,responseObject:x}));
async function setup({amount='10'}={}){
 const f=await fixture(),drafts=createFundingDrafts(f.store);await drafts.migrate();await createRestrictedTestPolicy(f.store).migrate();
 const policy=createRevolutPolicy(f.store);await policy.migrate();const tracker=createLiveStore(f.pool,{merchantId:'merchant'});await tracker.migrate();
 const accounts=createAccounts(f.store),a=await accounts.signup({email:'revolut@example.test',password:'revolut fixture account password',name:'Revolut fixture',acceptSandbox:true}),owner=(await accounts.session(a.token)).owner;
 const agent={id:randomUUID(),name:'Agent',address:remote().destinationAddress,network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);
 const {id}=await drafts.prepare(owner,{agentId:agent.id,requestId:randomUUID(),amount,rail:'revolut',confirm:true});
 const flags={available:true,loseResponse:false,settled:false,wrongRail:false},calls=[];
 const merchant={id:'merchant',environment:'LIVE',merchantConfig:{enabledRails:['wise'],quotePreference:'PREFER_SAR',feePayer:'MERCHANT',buyerFeeShareBps:0}};
 const order=()=>({...remote(),status:flags.settled?'FULFILLED':'CREATED',remainingUsdcAmount:flags.settled?'0':'12.5',requestedFiat:{amount,currency:'GBP'},enabledRails:[flags.wrongRail?'wise':'revolut'],dynamicOrdersEnabled:false,buyerFeeShareBps:0,notes:{relayOrderId:id},successUrl:'https://relay.example/?checkout='+id});
 const p=()=>({...payment(),rail:'revolut',paymentAmount:'10',quote:{...payment().quote,signalIntent:{...payment().quote.signalIntent,processorName:'revolut'}}});
 const fetcher=async(url,opts)=>{calls.push([url,opts.method??'GET']);if(url.endsWith('/me'))return envelope(merchant);if(url.includes('availability'))return envelope({available:flags.available,quoteCount:flags.available?1:0,nearbySuggestions:null});if(opts.method==='POST'){const b=JSON.parse(opts.body);assert.equal(b.requestedFiatAmount,Number(amount).toFixed(2));assert.deepEqual(b.enabledRails,['revolut']);assert.equal(b.feePayer,'MERCHANT');assert.equal(b.dynamicOrdersEnabled,false);if(flags.loseResponse)throw Error('lost');return envelope({order:order(),orderToken:'private-fixture'});}if(url.endsWith('/payments'))return envelope({payments:flags.settled?[p()]:[]});return envelope({merchant,order:order(),currentPayment:flags.settled?p():null});};
 const operator=createRevolutOperator({base:f.store,drafts,policy,tracker,merchantId:'merchant',apiKey:'fixture',origin:'https://relay.example',fetcher});
 const approve=opts=>operator.provision(owner,id,{walletAddress:agent.address,approvalRef:'fixture-approval',consentRef:'fixture-consent',...opts});
 const reader=createLiveReadService({apiKey:'fixture',merchantId:'merchant',rpc:rpc(),fetcher});
 const release=createRevolutRelease({drafts,policy,reader,store:tracker,merchantId:'merchant'});
 return {...f,drafts,policy,tracker,operator,approve,owner,id,agent,flags,calls,reader,release,token:a.token};
}
test('Revolut one-shot policy pins rail and wallet; unavailable liquidity consumes no attempt',async()=>{const f=await setup();try{
 await assert.rejects(f.operator.start(f.owner,f.id),/not approved/);assert.equal(f.calls.length,0);
 await assert.rejects(f.approve({maxTotalPence:1001}));await f.approve();
 await assert.rejects(f.store.query("UPDATE relay_funding_drafts SET rail='wise' WHERE id=$1",[f.id]),/Immutable/);
 await assert.rejects(f.store.query('UPDATE relay_revolut_policy SET max_total_pence=999'),/Immutable/);
 f.flags.available=false;await assert.rejects(f.operator.start(f.owner,f.id),/No Revolut offer/);assert.equal((await f.store.query('SELECT * FROM relay_revolut_attempt')).rows.length,0);
 assert.equal((await f.policy.status('customer:'+randomUUID())).id,undefined);
 }finally{await f.close();}});
test('parallel operator calls create one order; owner-only release rechecks provider and revocation',async()=>{const f=await setup();try{
 await f.approve();await Promise.all(Array.from({length:8},()=>f.operator.start(f.owner,f.id)));
 assert.equal(f.calls.filter(([u,m])=>m==='POST'&&!u.includes('availability')).length,1);
 const attempts=(await f.store.query('SELECT * FROM relay_revolut_attempt')).rows;assert.equal(attempts.length,1);assert.equal(attempts[0].reserved_pence,1000);
 await assert.rejects(f.store.query('DELETE FROM relay_revolut_attempt'),/permanent/);
 await assert.rejects(f.release('customer:'+randomUUID(),{id:f.id,confirm:true}));
 await assert.rejects(f.release(f.owner,{id:f.id,confirm:false}));
 const link=await f.release(f.owner,{id:f.id,confirm:true});assert.match(link.checkoutUrl,/method=revolut/);assert.equal(link.totalDebitCapEnforced,false);
 assert.ok(!JSON.stringify(await f.drafts.list(f.owner)).includes('private-fixture'));
 f.flags.wrongRail=true;await assert.rejects(f.release(f.owner,{id:f.id,confirm:true}));f.flags.wrongRail=false;
 await f.store.query('UPDATE relay_revolut_policy SET revoked=true');await assert.rejects(f.release(f.owner,{id:f.id,confirm:true}));
 }finally{await f.close();}});
test('unknown create remains permanently unresolved; restart never posts a replacement',async()=>{const f=await setup();try{
 await f.approve();f.flags.loseResponse=true;assert.equal((await f.operator.start(f.owner,f.id)).unresolved,true);
 await f.operator.start(f.owner,f.id);assert.equal(f.calls.filter(([u,m])=>m==='POST'&&!u.includes('availability')).length,1);
 await assert.rejects(f.release(f.owner,{id:f.id,confirm:true}));await assert.rejects(f.drafts.cancel(f.owner,{id:f.id}));
 }finally{await f.close();}});
test('Revolut settlement requires the pinned rail and exact finalised Base receipt',async()=>{const f=await setup();try{
 await f.approve();await f.operator.start(f.owner,f.id);f.flags.settled=true;
 const local=(await f.tracker.state(f.owner)).orders[0],r=await f.reader.refresh(local);assert.equal(r.status,'checkout_received');assert.equal(r.delivery.recipient,f.agent.address);assert.equal(r.delivery.amountRaw,'12000000');assert.equal(r.verification.payIn.rail,'revolut');assert.equal(r.verification.payIn.totalPence,1000);assert.equal(r.verification.payIn.allInLimitVerified,false);
 await assert.rejects(f.release(f.owner,{id:f.id,confirm:true}),/needs review/);
 }finally{await f.close();}});
test('HTTP runtime and simulation worker never import operator creation',()=>{
 for(const name of ['hosted/server.mjs','hosted/live-observation.mjs','hosted/revolut-test.mjs','hosted/worker.mjs'])assert.ok(!readFileSync(new URL('../'+name,import.meta.url),'utf8').includes('revolut-operator'));
});
test('private release HTTP route requires customer auth and same-origin review; general create remains blocked',async()=>{const f=await setup();let server;try{
 await f.approve();await f.operator.start(f.owner,f.id);
 server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},paymentsDisabled:true,allowHttpForTests:true,fundingDrafts:f.drafts,liveObservation:{simulated:false,store:f.tracker,policy:createRestrictedTestPolicy(f.store),revolutPolicy:f.policy,revolutRelease:f.release,status:async()=>({mode:'read_only'})}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(path,token=f.token,origin='https://relay.example')=>new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{host:'relay.example',origin,'content-type':'application/json',cookie:'__Host-relay_sandbox='+token}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(b)}));});q.on('error',reject);q.end(JSON.stringify({id:f.id,confirm:true}));});
 assert.equal((await request('/api/revolut-test/checkout','invalid')).status,401);
 assert.equal((await request('/api/revolut-test/checkout',f.token,'https://elsewhere.example')).status,403);
 assert.equal((await request('/api/checkouts')).status,403);
 assert.equal((await request('/api/revolut-test/create')).status,404);
 const before=f.calls.filter(([u,m])=>m==='POST').length;
 assert.equal((await request('/api/revolut-test/checkout')).status,200);
 assert.equal(f.calls.filter(([u,m])=>m==='POST').length,before);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}});

test('sub-£2 Revolut offers preserve exact pennies and do not lower the Wise minimum',async()=>{
 assert.equal(fundingPence('1.94','revolut'),194);
 for(const value of ['0','-1','1.943452','1e1','10.01',' 1.94'])assert.throws(()=>fundingPence(value,'revolut'));
 assert.throws(()=>fundingPence('1.94','wise'));
 const f=await setup({amount:'1.94'});try{
  await f.approve();await f.operator.start(f.owner,f.id);
  assert.equal((await f.tracker.state(f.owner)).orders[0].quote.pence,194);
  assert.equal((await f.release(f.owner,{id:f.id,confirm:true})).amountPence,194);
  await f.drafts.migrate();
  assert.equal((await f.drafts.review(f.owner,f.id)).pence,194);
 }finally{await f.close();}
});
