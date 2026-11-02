import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import samples from './fixtures/public-calculator-quotes.json' with {type:'json'};
import {buildQuoteRequest,normaliseQuoteResponse,BASE_USDC} from '../server/quote-first/direct-quote.mjs';
import {calculatorPolicy,calculatorInput,createTargetCalculator} from '../server/quote-first/target-calculator.mjs';
import {createTargetCalculatorHttp,configuredTargetCalculator,calculatorPath} from '../server/quote-first/target-calculator-http.mjs';
import {initialCalculatorState,calculatorReducer} from '../src/target-calculator-state.mjs';
import {calculatorSamples} from './fixtures/calculator-samples.mjs';
const sample=samples.wise,now=Date.parse(sample.checkedAt);
const input={amount:'25',currency:'GBP',method:'wise'};
function built(method='wise',currency='GBP'){return buildQuoteRequest({...input,method,currency,amountMode:'receive',chainId:8453,token:BASE_USDC,buyer:sample.request.user,recipient:sample.request.recipient},calculatorPolicy);}
function normalise(payload=structuredClone(sample.response),request=built(),clock=now){return normaliseQuoteResponse(payload,request,calculatorPolicy,{now:clock});}
test('public quotes without private seller identity reconcile across observed methods',()=>{
 for(const method of ['wise','revolut','venmo','zelle']){
  const s=samples[method];const r=normalise(s.response,built(method,s.request.fiatCurrency),Date.parse(s.checkedAt));
  assert.equal(r.status,'quotes_available');assert.equal(r.offers.length,s.response.responseObject.quotes.length);
  for(const q of r.offers){assert.equal(q.youReceive.amountRaw,'25000000');assert.equal(q.fee.amountRaw,'239777');assert.equal(q.canExecute,false);assert.equal(q.conditions.buyerEligibilityVerified,false);}
 }
 const q=normalise().offers[0];assert.equal(q.youPay.displayAmount,'19.42');assert.equal(q.youPay.providerDecimalAmount,'19.413909');assert.equal(q.youPay.exactPaymentAmountVerified,false);assert.equal(q.spreadBps,null);
});
test('Chime fee mismatch is withheld, not replaced by a fabricated total',()=>{
 const s=samples.chime,r=normalise(s.response,built('chime','USD'),Date.parse(s.checkedAt));
 assert.equal(r.status,'evidence_incomplete');assert.equal(r.offers.length,0);assert.equal(r.rejections[0].code,'inconsistent_fee_or_net');
});
test('asset, currency, recipient, target, fee, stake and access tampering are rejected',()=>{
 const edits=[p=>p.responseObject.token.chainId=1,p=>p.responseObject.fiat.currencyName='USD',p=>p.responseObject.fiat.currencyCode='0x'+'0'.repeat(64),p=>p.responseObject.quotes[0].intent.toAddress='0x'+'a'.repeat(40),p=>p.responseObject.quotes[0].tokenAmount='26000000',p=>p.responseObject.quotes[0].totalFeeAmount='0',p=>p.responseObject.quotes[0].intent.escrowAddress='0x'+'b'.repeat(40),p=>delete p.responseObject.quotes[0].disputeProtectionRequiresStake,p=>delete p.responseObject.quotes[0].whitelistEnabled];
 for(const edit of edits){const p=structuredClone(sample.response);edit(p);try{assert.equal(normalise(p).offers.length,0);}catch(e){assert.ok(e.code);}}
 const p=structuredClone(sample.response);p.responseObject.quoteExpiresAt=new Date(now).toISOString();assert.throws(()=>normalise(p),{code:'expired_quote'});
});
test('offer fingerprint ignores popularity counters but binds economic terms and payee hash',()=>{
 const original=normalise().offers[0];const p=structuredClone(sample.response);p.responseObject.quotes[0].depositSuccessRateBps=10000;assert.equal(normalise(p).offers[0].fingerprint,original.fingerprint);
 p.responseObject.quotes[0].intent.payeeDetails='0x'+'f'.repeat(64);assert.notEqual(normalise(p).offers[0].fingerprint,original.fingerprint);
});
test('target decimal maths rejects coercion, out of range and extra private fields',()=>{
 for(const amount of [25,'1e3','0','0.001','10001','-1','NaN','1.0000001'])assert.throws(()=>calculatorInput({...input,amount}));
 assert.equal(calculatorInput({...input,amount:'0.01'}).amount,'0.01');
 assert.throws(()=>calculatorInput({...input,recipient:'0x'+'a'.repeat(40)}));assert.throws(()=>calculatorInput({...input,method:'paypal'}));assert.throws(()=>calculatorInput({...input,currency:'BAD'}));
});
test('yen estimates round up to currency units rather than invented decimal places',()=>{
 const p=structuredClone(sample.response);p.responseObject.fiat.currencyName='JPY';p.responseObject.fiat.currencyCode=calculatorPolicy.routes.find(r=>r.method==='wise'&&r.currency==='JPY').currencyHash;p.responseObject.quotes[0].intent.fiatCurrencyCode=p.responseObject.fiat.currencyCode;
 assert.equal(normalise(p,built('wise','JPY')).offers[0].youPay.displayAmount,'20');
});
test('reader calls only the public quote endpoint and sends only example addresses',async()=>{
 const calls=[];const calculator=createTargetCalculator({clock:()=>now,fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(sample.response),{headers:{'Content-Type':'application/json'}});}});
 const r=await calculator.quotes(input),call=calls[0],b=JSON.parse(call.options.body);
 assert.equal(calls.length,1);assert.equal(call.url,'https://api.zkp2p.xyz/v3/quote/exact-token?quotesToReturn=3');assert.equal(call.options.redirect,'error');assert.equal(call.options.credentials,'omit');assert.deepEqual(Object.keys(call.options.headers).sort(),['Accept','Content-Type']);assert.equal(b.user,sample.request.user);assert.equal(b.recipient,sample.request.recipient);assert.equal(b.exactTokenAmount,'25000000');assert.deepEqual(b.referralFees,[]);
 assert.equal(r.rows[0].offers.length,1);assert.equal(r.canCreatePayment,false);assert.equal(r.eligibility,'example_addresses');assert.equal(JSON.stringify(r).includes('payeeDetails'),false);
});
test('no liquidity, authentication, provider error and invalid content stay distinct',async()=>{
 for(const [status,body,type,expected] of [[404,samples.monzo.response,'application/json','no_quotes'],[401,{},'application/json','provider_authentication_required'],[503,{},'application/json','quote_provider_unavailable'],[200,{},'text/html','invalid_content_type']]){
  const c=createTargetCalculator({clock:()=>now,fetchImpl:async()=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':type}})}),r=await c.quotes(input);assert.equal(r.rows[0].reason??r.rows[0].status,expected);assert.equal(r.rows[0].offers.length,0);
 }
});
const headers={host:'example.test','x-forwarded-proto':'https',origin:'https://example.test','sec-fetch-site':'same-origin','content-type':'application/json',cookie:'__Host-relay_sandbox='+'a'.repeat(64)};
async function http(handler,patch={}){const req=Readable.from([Buffer.from(patch.raw??JSON.stringify(patch.body??input))]);Object.assign(req,{url:patch.path??calculatorPath,method:patch.method??'POST',headers:{...headers,...patch.headers}});const res={writeHead(status,h){this.status=status;this.headers=h;},end(body){this.body=JSON.parse(body);}};res.handled=await handler(req,res);return res;}
const session={owner:'customer:sample',binding:'sample',expiresAt:Date.now()+60000};
test('disabled endpoint reads no session, store, configuration secret or provider',async()=>{
 const h=configuredTargetCalculator({store:new Proxy({},{get(){assert.fail('store accessed');}}),env:{get EUPOVA_BUYER_AUTH_SIGNING_KEY_PEM(){assert.fail('secret accessed');}}});
 assert.equal((await http(h)).status,404);assert.equal(h.available(),false);assert.equal((await http(h,{path:'/api/state'})).handled,false);
});
test('same-origin JSON session checks block forged, unauthenticated and excessive requests',async()=>{
 let reads=0,queries=0;const h=createTargetCalculatorHttp({origin:'https://example.test',enabled:()=>true,resolveSession:async()=>{reads++;return session;},rate:async()=>{},calculator:{quotes:async()=>{queries++;return {canCreatePayment:false};}}});
 for(const patch of [{headers:{origin:'https://evil.test'}},{headers:{'sec-fetch-site':'cross-site'}},{headers:{host:'evil.test'}},{headers:{'x-forwarded-proto':'http'}},{headers:{authorization:'Bearer sample'}},{path:calculatorPath+'?other=1'},{method:'GET'},{headers:{'content-type':'text/plain'}}])assert.ok((await http(h,patch)).status>=400);
 assert.equal(reads,0);assert.equal(queries,0);
 assert.equal((await http(h,{headers:{cookie:''}})).status,401);assert.equal((await http(h,{raw:'a'.repeat(513)})).status,413);assert.equal((await http(h,{body:{...input,address:'private'}})).status,400);assert.equal(queries,0);
 const ok=await http(h);assert.equal(ok.status,200);assert.equal(ok.headers['Cache-Control'],'no-store');assert.equal(queries,1);
});
test('revocation during quote read blocks result release',async()=>{
 let reads=0;const h=createTargetCalculatorHttp({origin:'https://example.test',enabled:()=>true,resolveSession:async()=>++reads===1?session:null,rate:async()=>{},calculator:{quotes:async()=>({canCreatePayment:false})}});assert.equal((await http(h)).status,403);
});
test('UI ignores out-of-order responses and clears old estimates when the target changes',()=>{
 let s=calculatorReducer(initialCalculatorState(),{type:'search'});const generation=s.generation;s=calculatorReducer(s,{type:'edit'});assert.equal(calculatorReducer(s,{type:'result',generation,rows:[{bad:true}]}),s);assert.equal(s.rows.length,0);
});
test('UI refresh preserves matching terms, clears changed offers and expires stale figures',()=>{
 const data=calculatorSamples(input,'available',now);let s=calculatorReducer(initialCalculatorState(),{type:'search'});s=calculatorReducer(s,{type:'result',generation:s.generation,...data});s=calculatorReducer(s,{type:'select',method:'wise',id:s.rows[0].offers[0].id,now});assert.ok(s.selected);
 s=calculatorReducer(s,{type:'search'});s=calculatorReducer(s,{type:'result',generation:s.generation,...data});assert.match(s.message,/still match/);
 s=calculatorReducer(s,{type:'search'});const changed=structuredClone(data);changed.rows[0].offers[0].id='changed';s=calculatorReducer(s,{type:'result',generation:s.generation,...changed});assert.equal(s.selected,null);assert.match(s.message,/changed/);
 s=calculatorReducer(s,{type:'expire',now:now+61000});assert.equal(s.phase,'expired');assert.equal(calculatorReducer(s,{type:'select',method:'wise',id:'changed',now:now+61000}).selected,null);
});
