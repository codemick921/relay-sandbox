import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedNetEstimate} from '../server/pay-net-estimate.mjs';
import {observePeerPayIn,observeCurrentSelection,payInProjection} from '../server/pay-payin.mjs';
import {fundingCosts} from '../src/funding-costs.mjs';
import {createLiveReadService} from '../server/pay-readonly.mjs';
import {fundingCatalog} from '../shared/fiat.mjs';
import {local,remote,payment,rpc} from './fixtures/live-evidence.mjs';
const now=Date.parse('2026-11-01T18:00:00Z');
function fixture(){
 const m={id:'merchant',environment:'LIVE',tier:'PRO',merchantConfig:{merchantId:'merchant',feePayer:'MERCHANT',buyerFeeShareBps:0,flatFeePricing:false,dynamicOrdersEnabled:false,destinationChainId:'8453',destinationToken:'USDC',platformReferralFeeConfig:{mode:'flat',currency:'USDC',valueBps:495},referralSplitConfig:null,updatedAt:'2026-11-01T17:25:44Z'}};
 const o={...remote(),status:'CREATED',createdAt:'2026-11-01T17:59:00Z',remainingUsdcAmount:'12.5',requestedFiat:{amount:'10',currency:'GBP'},referralSplitConfig:[],buyerFeeShareBps:0};
 const p={...payment(),status:'CREATED',paymentAmount:'0',netSettledUsdcAmount:null,totalUsdcFeeAmount:'0',currency:'GBP',currencyPerUsdRate:'0.8',penalties:[],quoteExpiresAt:new Date(now+60000).toISOString()};p.quote={...p.quote,sellerAutomatedReleaseAvailable:true,conversionRate:'0.8'};p.quote.signalIntent.amount='2551223';
 const l={...local(),quote:{pence:1000,currency:'GBP',platform:'wise'},requestedUsdcAmount:'12.5'};
 return {m,o,p,l};
}
function observation(f){return observePeerPayIn(f.l,{merchant:{id:'merchant',environment:'LIVE'},order:f.o,currentPayment:f.p},[structuredClone(f.p)],{now,merchant:f.m});}
test('standard Pro estimate matches the reconciled unadjusted gross and does not authorise payment',()=>{
 const f=fixture(),e=selectedNetEstimate(f.m,f.o,f.p);assert.equal(e.netUsdcRaw,'2424937');assert.equal(e.feeUsdcRaw,'126286'); // floor net: actual independently rounded settlement was one micro-USDC higher
 const v=observation(f);assert.equal(v.status,'within_peer_limit');assert.equal(v.receiveEstimate.netUsdcRaw,'2424937');assert.equal(v.paymentAuthorised,false);assert.equal(v.allInLimitVerified,false);
 const c=fundingCosts({requestedPence:1000,currency:'GBP',verification:{payIn:v},now});assert.equal(c.reviewPair.pay,'£10.00');assert.equal(c.reviewPair.receive,'2.424937 USDC');assert.equal(c.reviewPair.kind,'estimate');
});
test('missing terms, historical config, adjustments, fees and unsupported routes suppress the estimate',()=>{
 const cases=[f=>f.m=null,f=>f.m.id='other',f=>f.m.tier='BASE',f=>f.m.merchantConfig.flatFeePricing=true,f=>f.m.merchantConfig.platformReferralFeeConfig=null,f=>f.m.merchantConfig.platformReferralFeeConfig.valueBps=494,f=>f.m.merchantConfig.referralSplitConfig=[{}],f=>f.o.referralSplitConfig=[{}],f=>delete f.o.referralSplitConfig,f=>f.o.createdAt='2026-11-01T17:19:00Z',f=>f.o.createdAt='bad',f=>f.o.feePayer='PAYEE',f=>f.o.status='FULFILLED',f=>f.o.bridgeInfo={},f=>f.p.quote.amountAdjustment={},f=>f.p.quote.crossCurrency={},f=>f.p.penalties=[{kind:'CROSS_CURRENCY'}],f=>f.p.rail='revolut',f=>f.p.netSettledUsdcAmount='2',f=>f.p.quote.signalIntent.amount='1e6',f=>f.p.quote.signalIntent.amount='0'];
 for(const change of cases){const f=fixture();change(f);assert.equal(selectedNetEstimate(f.m,f.o,f.p),null,String(change));}
});
test('quote review disappears on expiry, stale check, amount/currency change or held state',()=>{
 const v=observation(fixture()),base={requestedPence:1000,currency:'GBP',verification:{payIn:v},now};
 for(const override of [{now:now+31000},{now:now+60000},{stopped:true},{ended:true},{review:true},{trackingError:true},{simulated:true},{currency:'EUR'},{requestedPence:999}])assert.equal(fundingCosts({...base,...override}).reviewPair,null,JSON.stringify(override));
 assert.equal(payInProjection(v,now+31000).receiveEstimate,null);
 for(const update of [{netUsdcRaw:'999999999'}, {feeConfigFingerprint:''},{feeBps:0}])assert.equal(fundingCosts({...base,verification:{payIn:{...v,receiveEstimate:{...v.receiveEstimate,...update}}}}).reviewPair,null);
});
test('settlement actuals replace estimates; arrival is a separate confirmed value',()=>{
 const payIn=observation(fixture());payIn.status='settled_observation';payIn.settlement={paymentAmount:'1.98',currency:'GBP',netUsdcRaw:'2372893',feeUsdcRaw:'123573'};
 const v={payIn,expectedNetRaw:'2372893',payments:[{id:payIn.paymentId,status:'SETTLED',currency:'GBP',amountRaw:'2372893',feeRaw:'123573',adjustments:[{kind:'CROSS_CURRENCY',penaltyBps:300,originalAmount:'1.98',attestedAmount:'1.92'}]}]};
 let c=fundingCosts({verification:v,now});assert.equal(c.reviewPair.kind,'settled');assert.equal(c.reviewPair.pay,'1.98 GBP');assert.equal(c.reviewPair.receive,'2.372893 USDC');assert.equal(c.reviewPair.arrived,false);assert.match(c.adjustments[0],/3%/);
 v.receivedRaw='2372893';assert.equal(fundingCosts({verification:v,now}).reviewPair.arrived,true);
 v.payments[0].amountRaw='3';assert.equal(fundingCosts({verification:v,now}).reviewPair,null);
});
test('reader binds the estimate to stable fee config; reconfiguration withholds it using GET only',async()=>{
 for(const change of [false,true]){
  const f=fixture();f.p.quoteExpiresAt=new Date(Date.now()+60000).toISOString();let reads=0;const calls=[];
  const reader=createLiveReadService({apiKey:'fixture',merchantId:'merchant',rpc:rpc(),fetcher:async(url,options)=>{assert.equal(options.method,'GET');calls.push(url);let d;if(url.endsWith('/me')){d=structuredClone(f.m);if(++reads===2&&change)d.merchantConfig.platformReferralFeeConfig.valueBps=600;}else if(url.endsWith('/payments'))d={payments:[f.p]};else d={merchant:{id:'merchant',environment:'LIVE'},order:f.o,currentPayment:f.p};return new Response(JSON.stringify({success:true,responseObject:d}));}});
  const result=await reader.refresh(f.l);assert.equal(!!result.verification.payIn.receiveEstimate,!change);assert.equal(calls.length,5);
 }
});

// Synthetic contracts exercise method support; they are not live settlement evidence.
const methodCases=[['wise','GBP',true],['venmo','USD',false],['revolut','GBP',false],['revolut','EUR',false],['revolut','USD',false],['cashapp','USD',true],['cashapp','USD',false],['zelle','USD',false],['monzo','GBP',false],['chime','USD',false]];
function methodFixture(rail,currency,sar){const f=fixture();f.l.quote={pence:1000,currency,platform:rail};f.o.enabledRails=[rail];f.o.requestedFiat={amount:'10',currency};f.p.rail=rail;f.p.currency=currency;f.p.quote.signalIntent.processorName=rail;f.p.quote.sellerAutomatedReleaseAvailable=sar;return f;}
test('existing fiat methods expose the same conditional estimate without requiring seller automation on buyer-proof methods',()=>{
 for(const [rail,currency,sar] of methodCases){const f=methodFixture(rail,currency,sar),v=observation(f);assert.equal(v.status,'within_peer_limit',rail);assert.equal(v.receiveEstimate?.netUsdcRaw,'2424937',rail);const c=fundingCosts({requestedPence:1000,currency,verification:{payIn:v},now});assert.equal(c.reviewPair?.receive,'2.424937 USDC',rail);assert.equal(c.reviewPair?.kind,'estimate');assert.equal(v.paymentAuthorised,false);}
});
test('new method estimates remain bound to their currency, exact rail, quote and supported payout semantics',()=>{
 const changes=[f=>f.p.rail='venmo',f=>{f.p.rail='paypal';f.p.quote.signalIntent.processorName='paypal'},f=>{f.p.rail='relay_8453';f.p.quote.signalIntent.processorName='relay_8453'},f=>f.o.enabledRails=['wise'],f=>f.o.enabledRails.push('wise'),f=>f.p.currency='ARS',f=>f.p.quote.signalIntent.processorName='wise',f=>delete f.p.quote.sellerAutomatedReleaseAvailable,f=>f.p.payout={status:'HELD'},f=>f.p.payout={releaseEligibleAt:'2026-12-01T00:00:00Z'},f=>f.p.quote.crossCurrency={},f=>f.p.quote.amountAdjustment={},f=>f.p.penalties=[{kind:'PURCHASE_PROTECTION',penaltyBps:299}]];
 for(const change of changes){const f=methodFixture('revolut','GBP',false);change(f);assert.equal(selectedNetEstimate(f.m,f.o,f.p),null,String(change));}
 for(const rail of ['paypal','n26','new_app']){const f=methodFixture(rail,'USD',true);assert.equal(selectedNetEstimate(f.m,f.o,f.p),null,rail);}
 const f=methodFixture('wise','GBP',false);assert.equal(selectedNetEstimate(f.m,f.o,f.p),null);
});
test('each added method survives the complete GET-only observer and loses its estimate when fee configuration changes',async()=>{
 for(const rail of ['venmo','revolut','cashapp','zelle','monzo','chime'])for(const changed of [false,true]){
  const currency=['revolut','monzo'].includes(rail)?'GBP':'USD',f=methodFixture(rail,currency,false);f.p.quoteExpiresAt=new Date(Date.now()+60000).toISOString();let profiles=0;const calls=[];
  const reader=createLiveReadService({apiKey:'fixture',merchantId:'merchant',rpc:rpc(),fetcher:async(url,options)=>{assert.equal(options.method,'GET');calls.push(url);let data;if(url.endsWith('/me')){data=structuredClone(f.m);if(++profiles===2&&changed)data.merchantConfig.platformReferralFeeConfig.valueBps=600;}else if(url.endsWith('/payments'))data={payments:[f.p]};else data={merchant:{id:'merchant',environment:'LIVE'},order:f.o,currentPayment:f.p};return new Response(JSON.stringify({success:true,responseObject:data}));}});
  const result=await reader.refresh(f.l);assert.equal(!!result.verification.payIn.receiveEstimate,!changed,rail);assert.equal(calls.length,5);assert.equal(result.verification.payIn.paymentAuthorised,false);
 }
});

test('every enabled method and currency uses selected gross output, with spread and fee counted once',()=>{
 let count=0;
 for(const method of fundingCatalog.methods.filter(m=>m.checkoutSupported))for(const currency of method.currencies){
  const f=methodFixture(method.id,currency,method.id==='wise');
  f.p.currencyPerUsdRate='1';f.p.quote.conversionRate='1.1';f.o.remainingUsdcAmount='10';
  f.p.quote.signalIntent.amount='9090909';
  const aggregate={merchant:{id:'merchant',environment:'LIVE'},order:f.o,currentPayment:f.p};
  const v=observeCurrentSelection(f.l,aggregate,[f.p],{now,merchant:f.m});
  assert.equal(v.receiveEstimate.netUsdcRaw,'8640909',method.id+currency);
  assert.equal(v.receiveEstimate.feeUsdcRaw,'450000');
  const pair=fundingCosts({requestedPence:1000,currency,verification:{payIn:{schema:'peer-fiat-v2',status:'quote_changed',currentSelection:v}},now}).reviewPair;
  assert.equal(pair.receive,'8.640909 USDC');assert.equal(pair.offerRate,'1.1 '+currency+' per USDC');assert.equal(pair.spreadIncluded,true);count++;
 }
 assert.equal(count,fundingCatalog.methods.filter(m=>m.checkoutSupported).reduce((n,m)=>n+m.currencies.length,0));assert.ok(count>50);
});
test('fresh selected replacement is displayed without clearing the old policy observation',()=>{
 const f=fixture(),first=observation(f);f.l.verification={payIn:first};
 f.p.id='replacement';f.p.quote.signalIntent.amount='2400000';f.p.quote.conversionRate='0.83';
 const old={...structuredClone(f.p),id:first.paymentId,status:'EXPIRED',fulfillTransaction:null};
 const a={merchant:{id:'merchant',environment:'LIVE'},order:f.o,currentPayment:f.p},history=[old,structuredClone(f.p)];
 const policy=observePeerPayIn(f.l,a,history,{now,merchant:f.m});assert.equal(policy.status,'multiple_attempts');
 const currentSelection=observeCurrentSelection(f.l,a,history,{now,merchant:f.m});assert.equal(currentSelection.paymentId,'replacement');assert.equal(currentSelection.receiveEstimate.netUsdcRaw,'2281200');
 const payIn={...policy,currentSelection};let costs=fundingCosts({requestedPence:1000,currency:'GBP',verification:{payIn},now});assert.equal(costs.reviewPair.receive,'2.281200 USDC');assert.equal(policy.status,'multiple_attempts');
 assert.equal(fundingCosts({requestedPence:1000,verification:{payIn},now:now+31000}).reviewPair,null);
 assert.equal(payInProjection(payIn,now+31000).currentSelection.receiveEstimate,null);
 assert.equal(fundingCosts({requestedPence:1000,verification:{payIn:{...first,currentSelection:null}},now}).reviewPair,null);
});
test('a second active, paid, disputed, duplicate or foreign attempt cannot supply replacement pricing',()=>{
 const changes=[p=>p.status='CREATED',p=>p.status='SETTLED',p=>p.paymentAmount='1',p=>p.netSettledUsdcAmount='1',p=>p.chargebackStatus='CHARGEBACKED',p=>p.fulfillTransaction='0x'+ 'a'.repeat(64),p=>p.orderId='other',p=>p.id='payment-1'];
 for(const change of changes){const f=fixture(),old={...structuredClone(f.p),id:'old',status:'EXPIRED',fulfillTransaction:null};change(old);assert.equal(observeCurrentSelection(f.l,{merchant:{id:'merchant',environment:'LIVE'},order:f.o,currentPayment:f.p},[old,f.p],{now,merchant:f.m}),null);}
});
test('missing or malformed selected rate and unknown deductions suppress net estimates',()=>{
 for(const rate of [null,undefined,'0','-1','NaN','1e2','', ' 1','9'.repeat(40)]){const f=fixture();f.p.quote.conversionRate=rate;assert.equal(selectedNetEstimate(f.m,f.o,f.p),null);}
 const f=methodFixture('venmo','USD',false);assert.ok(selectedNetEstimate(f.m,f.o,f.p));f.p.penalties=[{kind:'PURCHASE_PROTECTION',penaltyBps:299}];assert.equal(selectedNetEstimate(f.m,f.o,f.p),null);
});
test('GET-only reader exposes current selected offer separately and suppresses it after profile change',async()=>{
 for(const changed of [false,true]){const f=fixture();f.p.quoteExpiresAt=new Date(Date.now()+60000).toISOString();const old={...structuredClone(f.p),id:'old',status:'CANCELLED',fulfillTransaction:null};let profiles=0;
 const reader=createLiveReadService({apiKey:'fixture',merchantId:'merchant',rpc:rpc(),fetcher:async(url,options)=>{assert.equal(options.method,'GET');let response;if(url.endsWith('/me')){response=structuredClone(f.m);if(++profiles===2&&changed)response.merchantConfig.platformReferralFeeConfig.valueBps=600;}else if(url.endsWith('/payments'))response={payments:[old,f.p]};else response={merchant:{id:'merchant',environment:'LIVE'},order:f.o,currentPayment:f.p};return Response.json({success:true,responseObject:response});}});
 const result=await reader.refresh(f.l);assert.equal(result.verification.payIn.status,'multiple_attempts');assert.equal(!!result.verification.payIn.currentSelection,!changed);
 }
});
