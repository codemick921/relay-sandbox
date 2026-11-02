import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {getOrchestratorV3Contract} from '@zkp2p/sdk';
import {pinnedOrchestrator,reviewInput,compareSelectedQuote} from '../server/quote-first/quote-review.mjs';
import {calculatorInput,createTargetCalculator} from '../server/quote-first/target-calculator.mjs';
import {calculatorReviewPath,configuredTargetCalculator,createTargetCalculatorHttp} from '../server/quote-first/target-calculator-http.mjs';
import {calculatorSamples} from './fixtures/calculator-samples.mjs';
import samples from './fixtures/public-calculator-quotes.json' with {type:'json'};
import {initialCalculatorState,calculatorReducer} from '../src/target-calculator-state.mjs';
const input={amount:'25',currency:'GBP',method:'wise'},now=Date.parse(samples.wise.checkedAt),data=calculatorSamples(input,'available',now),id=data.rows[0].offers[0].id;
const selected={...input,offerId:id};
test('quoted contract cannot inherit the pinned SDK execution capability',()=>{
 assert.equal(getOrchestratorV3Contract(8453,'production').address.toLowerCase(),pinnedOrchestrator);
 const quoted=samples.wise.response.responseObject.orchestratorAddress;
 assert.notEqual(quoted.toLowerCase(),pinnedOrchestrator);
 assert.equal(data.rows[0].offers[0].integration.contractVersion,'v4');assert.equal(data.rows[0].offers[0].integration.sdkCompatible,false);assert.equal(data.rows[0].offers[0].integration.canReserve,false);
});
test('review accepts only one supported method and opaque selected terms; no wallet/private payload',()=>{
 assert.equal(reviewInput(selected,calculatorInput).offerId,id);
 for(const patch of [{offerId:'unknown'},{method:'all'},{method:'paypal'},{recipient:'private'},{buyer:'private'},{signature:'private'},{amount:'1e6'},{currency:'BAD'}])assert.throws(()=>reviewInput({...selected,...patch},calculatorInput));
});
test('same terms refresh without reserving or enabling execution; changed terms require new selection',()=>{
 const match=compareSelectedQuote(id,data,{now});assert.equal(match.status,'terms_match');assert.equal(match.offer.id,id);assert.equal(match.canCreatePayment,false);assert.equal(match.reserved,false);assert.equal(match.offer.canExecute,false);assert.equal(match.readiness.contract,'execution_not_verified');assert.equal(match.eligibility,'example_addresses');
 const changed=calculatorSamples(input,'available',now,true),r=compareSelectedQuote(id,changed,{now});assert.equal(r.status,'terms_changed');assert.equal(r.offer,null);assert.notEqual(r.rows[0].offers[0].youPay.displayAmount,data.rows[0].offers[0].youPay.displayAmount);
});
test('expired, missing and failed offers never become a valid review',()=>{
 assert.equal(compareSelectedQuote(id,data,{now:now+60000}).status,'refresh_required');
 assert.equal(compareSelectedQuote(id,calculatorSamples(input,'none',now),{now}).status,'offer_unavailable');
 assert.equal(compareSelectedQuote(id,calculatorSamples(input,'invalid',now),{now}).status,'could_not_verify');
 assert.throws(()=>compareSelectedQuote(id,{...data,route:'peer_merchant'},{now}));assert.throws(()=>compareSelectedQuote(id,{...data,checkedAt:now+1},{now}));
});
test('server rechecks one exact public-quote method, sending no customer details or reservation',async()=>{
 const calls=[];const c=createTargetCalculator({clock:()=>now,fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(samples.wise.response),{headers:{'Content-Type':'application/json'}});}});
 const first=await c.quotes(input),r=await c.review({...input,offerId:first.rows[0].offers[0].id});assert.equal(r.status,'terms_match');assert.equal(calls.length,2);
 for(const call of calls){assert.equal(call.url,'https://api.zkp2p.xyz/v3/quote/exact-token?quotesToReturn=3');const b=JSON.parse(call.options.body);assert.equal(b.user,samples.wise.request.user);assert.equal(b.recipient,samples.wise.request.recipient);assert.deepEqual(b.paymentPlatforms,['wise']);assert.equal(call.options.credentials,'omit');}
 for(const field of ['payeeDetails','gatingServiceSignature','calldata','privateKey'])assert.equal(JSON.stringify(r).includes(field),false);
});
const session={owner:'customer:sample',binding:'sample'},headers={host:'example.test','x-forwarded-proto':'https',origin:'https://example.test','sec-fetch-site':'same-origin','content-type':'application/json',cookie:'__Host-relay_sandbox='+'a'.repeat(64)};
async function http(h,patch={}){const req=Readable.from([Buffer.from(patch.raw??JSON.stringify(patch.body??selected))]);Object.assign(req,{url:patch.path??calculatorReviewPath,method:patch.method??'POST',headers:{...headers,...patch.headers}});const res={writeHead(status,h){this.status=status;this.headers=h;},end(s){this.body=JSON.parse(s);}};res.handled=await h(req,res);return res;}
test('disabled review and invalid requests cannot call sessions or quote provider',async()=>{
 const never=()=>assert.fail('side effect');assert.equal((await http(configuredTargetCalculator({store:new Proxy({},{get:never}),env:{}}))).status,404);
 let calls=0;const h=createTargetCalculatorHttp({origin:'https://example.test',enabled:()=>true,resolveSession:async()=>session,rate:async()=>{},calculator:{review:async()=>{calls++;return compareSelectedQuote(id,data,{now});}}});
 for(const patch of [{body:{...selected,recipient:'secret'}},{body:{...selected,method:'all'}},{headers:{origin:'https://evil.test'}},{headers:{cookie:''}},{path:calculatorReviewPath+'?x=1'},{raw:'x'.repeat(513)},{method:'GET'}])assert.ok((await http(h,patch)).status>=400);
 assert.equal(calls,0);const r=await http(h);assert.equal(r.status,200);assert.equal(r.body.reserved,false);assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(calls,1);
});
test('review respects account-session revocation and shared rate limiting',async()=>{
 let reads=0;const h=createTargetCalculatorHttp({origin:'https://example.test',enabled:()=>true,resolveSession:async()=>++reads===1?session:null,rate:async()=>{},calculator:{review:async()=>data}});assert.equal((await http(h)).status,403);
 const limited=createTargetCalculatorHttp({origin:'https://example.test',enabled:()=>true,resolveSession:async()=>session,rate:async()=>{throw Object.assign(Error(),{status:429});},calculator:{review:()=>assert.fail()}});assert.equal((await http(limited)).status,429);
});
function uiSelected(){let s=calculatorReducer(initialCalculatorState(),{type:'search'});s=calculatorReducer(s,{type:'result',generation:s.generation,...data});return calculatorReducer(s,{type:'select',method:'wise',id,now});}
test('review UI preserves target on Back and expires a plan independently of other offers',()=>{
 let s=calculatorReducer(uiSelected(),{type:'review'});s=calculatorReducer(s,{type:'reviewed',generation:s.generation,result:compareSelectedQuote(id,data,{now})});assert.ok(s.plan);const back=calculatorReducer(s,{type:'review-back'});assert.equal(back.plan,null);assert.equal(back.selected.offer.id,id);
 s=calculatorReducer(s,{type:'expire',now:now+60000});assert.equal(s.plan,null);assert.equal(s.selected,null);assert.equal(s.phase,'expired');
});
test('target edit, back and new search discard late review responses',()=>{
 for(const action of [{type:'edit'},{type:'back'},{type:'search'}]){let s=calculatorReducer(uiSelected(),{type:'review'});const generation=s.generation;s=calculatorReducer(s,action);assert.equal(calculatorReducer(s,{type:'reviewed',generation,result:compareSelectedQuote(id,data,{now})}),s);}
});
test('changed or unavailable review clears selected offer rather than accepting a replacement',()=>{
 for(const result of [compareSelectedQuote(id,calculatorSamples(input,'available',now,true),{now}),compareSelectedQuote(id,calculatorSamples(input,'none',now),{now})]){let s=calculatorReducer(uiSelected(),{type:'review'});s=calculatorReducer(s,{type:'reviewed',generation:s.generation,result});assert.equal(s.plan,null);assert.equal(s.selected,null);assert.ok(s.message);}
});
