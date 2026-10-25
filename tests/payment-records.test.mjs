import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {paymentRecord,paymentRecords,renderRecord,units} from '../hosted/payment-records.mjs';
import {verifyPayDelivery} from '../server/pay-delivery.mjs';
import {local,remote,payment,rpc} from './fixtures/live-evidence.mjs';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createHostedServer} from '../hosted/server.mjs';
const now=Date.now();
async function received(){const o={...local(),id:randomUUID(),createdAt:new Date(now).toISOString()};return {...o,...await verifyPayDelivery(o,remote(),[payment()],{rpc:rpc(),now})};}

test('receipt requires matched finalised delivery, not Peer fulfilment or a status label',async()=>{
 const o=await received(),r=paymentRecord(o,null,now);assert.equal(r.document,'receipt');assert.equal(r.netUsdc,'12.000000');assert.equal(r.confirmedUsdc,'12.000000');assert.equal(r.peerFeeUsdc,'0.500000');assert.equal(r.requestedGbp,'25.00');assert.equal(r.recordedFiat,null);assert.equal(r.receipts.length,1);
 for(const change of [x=>{x.delivery=null;},x=>{x.reviewRequired=true;},x=>{x.verification.providerFulfilled=false;},x=>{x.verification.payments[0].receipt.recipient='0x'+'2'.repeat(40);},x=>{x.verification.payments[0].receipt.tokenAddress='0x'+'2'.repeat(40);},x=>{x.verification.payments[0].receipt.finalized=false;},x=>{x.delivery.amountRaw='12000001';},x=>{x.verification.receivedRaw='1';},x=>{x.verification.payments.push({...x.verification.payments[0]});}]){
  const altered=structuredClone(o);change(altered);assert.equal(paymentRecord(altered,null,now).document,'summary');
 }
 const unpaid=paymentRecord({...local(),verification:{providerFulfilled:true}});assert.equal(unpaid.document,'summary');assert.equal(unpaid.confirmedUsdc,null);
});

test('partial, confirming, review, uncertain and stopped records offer distinct recovery instructions',async()=>{
 const cases=[['checkout_partial','partial'],['checkout_confirming','confirming'],['checkout_settled','settled'],['checkout_review','review'],['checkout_unknown','uncertain'],['checkout_recovery','uncertain'],['checkout_cancelled','ended']];
 for(const [status,code] of cases){const r=paymentRecord({...local(),status});assert.equal(r.code,code);assert.equal(r.document,'summary');}
 const stopped=paymentRecord({...local(),stoppedInRelay:true});assert.equal(stopped.code,'stopped');assert.match(stopped.next,/does not cancel/);
 const late=paymentRecord({...await received(),stoppedInRelay:true});assert.equal(late.code,'received');assert.equal(late.stopped,true);assert.equal(late.document,'receipt');
 const dispute=paymentRecord({...await received(),chargebackStatus:'CHARGEBACKED'});assert.equal(dispute.code,'disputed');assert.match(dispute.next,/historical/);assert.equal(dispute.document,'receipt');
});

test('unknown fees stay unknown, zero fees stay zero, recorded fiat is independent of requested GBP',async()=>{
 const o=await received();delete o.verification.payments[0].feeRaw;assert.equal(paymentRecord(o).peerFeeUsdc,null);
 o.verification.payments[0].feeRaw='0';assert.equal(paymentRecord(o).peerFeeUsdc,'0.000000');
 o.verification.payIn={settlement:{paymentAmount:'5.93',currency:'USD'}};const r=paymentRecord(o);assert.equal(r.recordedFiat,'5.93 USD');assert.equal(r.requestedGbp,'25.00');
 assert.equal(units('123456789012345678901234'),'123456789012345678.901234');
});

test('downloads allowlist fields, escape HTML and CSV formulas and visibly label simulation',async()=>{
 const o=await received();o.fixture=true;o.agent.name=' =HYPERLINK("https://evil")<script>alert(1)</script>';o.checkoutUrl='SECRET-CHECKOUT-TOKEN';o.email='PRIVATE-EMAIL';
 const r=paymentRecord(o),html=renderRecord(r,'html'),csv=renderRecord(r,'csv');
 assert.match(html,/SIMULATED/);assert.match(html,/&lt;script&gt;/);assert.ok(!html.includes('<script>'));assert.match(csv,/"' =HYPERLINK/);
 for(const data of [JSON.stringify(r),html,csv]){assert.ok(!data.includes('SECRET-CHECKOUT-TOKEN'));assert.ok(!data.includes('PRIVATE-EMAIL'));}
 assert.ok(!html.includes('basescan.org'));assert.match(html,/No real payment/);
});

test('saved evidence remains dated during tracking outages; draft merge preserves history',async()=>{
 const o=await received();o.trackingError='private diagnostic';o.checkedAt=new Date(now-3600000).toISOString();
 const d={id:o.id,status:'bound',stoppedAt:new Date().toISOString()},other={id:randomUUID(),status:'draft',pence:500,agent:o.agent};
 const records=paymentRecords({orders:[o,o],fundingDrafts:[d,other]},now);assert.equal(records.length,2);const r=records.find(r=>r.id===o.id);assert.equal(r.stale,true);assert.equal(r.trackingUnavailable,true);assert.equal(r.document,'receipt');assert.equal(r.hasDraft,true);assert.equal(r.stopped,true);assert.ok(!JSON.stringify(r).includes('private diagnostic'));
 assert.equal(records.find(r=>r.id===other.id).code,'draft');
});

test('HTTP downloads enforce customer ownership, session revocation, same-origin reads and current evidence without provider calls',async()=>{
 const f=await fixture();let server;try{
  const accounts=createAccounts(f.store),signup=email=>accounts.signup({email,name:'Receipt tester',password:'correct horse meadow lantern',acceptSandbox:true});
  const alice=await signup('alice@example.test'),bob=await signup('bob@example.test'),owner='customer:'+alice.account.id;let o=await received(),calls=0;
  const tracking={simulated:true,store:{state:async who=>({orders:who===owner?[o]:[]}),health:async()=>({healthy:true})}};
  server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},allowHttpForTests:true,paymentsDisabled:true,tracking,pay:{readiness:async()=>{calls++;throw Error('Must not contact provider');}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const req=(path,{token=alice.token,method='GET',site='same-origin'}={})=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:'relay.example',origin:'https://relay.example','content-type':'application/json','sec-fetch-site':site,cookie:token?'__Host-relay_sandbox='+token:''}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});r.on('error',reject);r.end(method==='POST'?'{}':undefined);});
  const path=`/api/payment-records/${o.id}/download?format=html`;
  assert.equal((await req(path,{token:null})).status,401);assert.equal((await req(path,{token:bob.token})).status,404);assert.equal((await req(path,{site:'cross-site'})).status,403);assert.equal((await req(path,{method:'POST'})).status,405);
  const list=await req('/api/payment-records');assert.equal(JSON.parse(list.body).records.length,1);assert.equal(JSON.parse((await req('/api/payment-records',{token:bob.token})).body).records.length,0);
  const downloaded=await req(path);assert.equal(downloaded.status,200);assert.equal(downloaded.headers['cache-control'],'no-store');assert.match(downloaded.headers['content-disposition'],/attachment; filename="eupova-simulated-receipt-/);assert.match(downloaded.body,/12.000000/);
  o={...o,reviewRequired:true};const changed=await req(path);assert.match(changed.headers['content-disposition'],/simulated-summary/);assert.match(changed.body,/need review/);
  assert.equal((await req(path.replace('html','exe'))).status,400);assert.equal((await req('/healthz')).body.includes('"realPaymentsEnabled":false'),true);assert.equal(calls,0);
  await accounts.logout(alice.token);assert.equal((await req(path)).status,401);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});

test('a transfer check on a partially paid order does not imply that no balance remains',()=>{
 for(const status of ['checkout_settled','checkout_confirming']){
  const partial=paymentRecord({...local(),status,verification:{providerFulfilled:false}});assert.match(partial.next,/full payment has not been confirmed/);assert.ok(!partial.next.includes('no further bank payment'));
  const full=paymentRecord({...local(),status,verification:{providerFulfilled:true}});assert.match(full.next,/further bank payment is needed/);
 }
});

test('PostgreSQL Date values and JSON timestamps produce the same creation date',()=>{
 const date=new Date('2026-10-24T12:00:00Z');assert.equal(paymentRecord({...local(),createdAt:date}).createdAt,date.toISOString());assert.equal(paymentRecord({...local(),createdAt:date.toISOString()}).createdAt,date.toISOString());
});

test('a saved payment dispute remains visible when the aggregate order has not caught up',async()=>{
 const o=await received();o.chargebackStatus='NONE';o.verification.payments[0].chargebackStatus='CHARGEBACKED';
 const r=paymentRecord(o);assert.equal(r.chargeback,true);assert.equal(r.code,'disputed');assert.equal(r.document,'receipt');
});

test('delivery export rejects contradictory receipt summaries and duplicate or empty settlement identities',async()=>{
 const o=await received();
 for(const change of [x=>{x.delivery.receipts=[];},x=>{x.delivery.receipts=[null];},x=>{x.verification.payments=[null];},x=>{x.verification.payments[0].intentHash=123;},x=>{x.delivery.receipts[0].blockHash='0x'+'12'.repeat(32);},x=>{x.verification.payments[0].intentHash='invalid';},x=>{x.verification.payments[0].id='';}]){
  const x=JSON.parse(JSON.stringify(o));change(x);assert.equal(paymentRecord(x).document,'summary');
 }
});
