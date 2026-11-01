import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedNetEstimate} from '../server/pay-net-estimate.mjs';
import {observePeerPayIn,payInProjection} from '../server/pay-payin.mjs';
import {fundingCosts} from '../src/funding-costs.mjs';
import {createLiveReadService} from '../server/pay-readonly.mjs';
import {local,remote,payment,rpc} from './fixtures/live-evidence.mjs';
const now=Date.parse('2026-11-01T18:00:00Z');
function fixture(){
 const m={id:'merchant',environment:'LIVE',tier:'PRO',merchantConfig:{merchantId:'merchant',feePayer:'MERCHANT',buyerFeeShareBps:0,flatFeePricing:false,dynamicOrdersEnabled:false,destinationChainId:'8453',destinationToken:'USDC',platformReferralFeeConfig:{mode:'flat',currency:'USDC',valueBps:495},referralSplitConfig:null,updatedAt:'2026-11-01T17:25:44Z'}};
 const o={...remote(),status:'CREATED',createdAt:'2026-11-01T17:59:00Z',remainingUsdcAmount:'12.5',requestedFiat:{amount:'10',currency:'GBP'},referralSplitConfig:[],buyerFeeShareBps:0};
 const p={...payment(),status:'CREATED',paymentAmount:'0',netSettledUsdcAmount:null,totalUsdcFeeAmount:'0',currency:'GBP',currencyPerUsdRate:'0.8',penalties:[],quoteExpiresAt:new Date(now+60000).toISOString()};p.quote={...p.quote,sellerAutomatedReleaseAvailable:true};p.quote.signalIntent.amount='2551223';
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
const methodCases=[['wise','GBP',true],['revolut','GBP',false],['revolut','EUR',false],['revolut','USD',false],['cashapp','USD',true],['cashapp','USD',false],['zelle','USD',false],['monzo','GBP',false],['chime','USD',false]];
function methodFixture(rail,currency,sar){const f=fixture();f.l.quote={pence:1000,currency,platform:rail};f.o.enabledRails=[rail];f.o.requestedFiat={amount:'10',currency};f.p.rail=rail;f.p.currency=currency;f.p.quote.signalIntent.processorName=rail;f.p.quote.sellerAutomatedReleaseAvailable=sar;return f;}
test('existing fiat methods expose the same conditional estimate without requiring seller automation on buyer-proof methods',()=>{
 for(const [rail,currency,sar] of methodCases){const f=methodFixture(rail,currency,sar),v=observation(f);assert.equal(v.status,'within_peer_limit',rail);assert.equal(v.receiveEstimate?.netUsdcRaw,'2424937',rail);const c=fundingCosts({requestedPence:1000,currency,verification:{payIn:v},now});assert.equal(c.reviewPair?.receive,'2.424937 USDC',rail);assert.equal(c.reviewPair?.kind,'estimate');assert.equal(v.paymentAuthorised,false);}
});
test('new method estimates remain bound to their currency, exact rail, quote and supported payout semantics',()=>{
 const changes=[f=>f.p.rail='venmo',f=>{f.p.rail='paypal';f.p.quote.signalIntent.processorName='paypal'},f=>{f.p.rail='relay_8453';f.p.quote.signalIntent.processorName='relay_8453'},f=>f.o.enabledRails=['wise'],f=>f.o.enabledRails.push('wise'),f=>f.p.currency='ARS',f=>f.p.quote.signalIntent.processorName='wise',f=>delete f.p.quote.sellerAutomatedReleaseAvailable,f=>f.p.payout={status:'HELD'},f=>f.p.payout={releaseEligibleAt:'2026-12-01T00:00:00Z'},f=>f.p.quote.crossCurrency={},f=>f.p.quote.amountAdjustment={},f=>f.p.penalties=[{kind:'PURCHASE_PROTECTION',penaltyBps:299}]];
 for(const change of changes){const f=methodFixture('revolut','GBP',false);change(f);assert.equal(selectedNetEstimate(f.m,f.o,f.p),null,String(change));}
 for(const rail of ['venmo','paypal','n26','new_app']){const f=methodFixture(rail,'USD',true);assert.equal(selectedNetEstimate(f.m,f.o,f.p),null,rail);}
 const f=methodFixture('wise','GBP',false);assert.equal(selectedNetEstimate(f.m,f.o,f.p),null);
});
test('each added method survives the complete GET-only observer and loses its estimate when fee configuration changes',async()=>{
 for(const rail of ['revolut','cashapp','zelle','monzo','chime'])for(const changed of [false,true]){
  const currency=['revolut','monzo'].includes(rail)?'GBP':'USD',f=methodFixture(rail,currency,false);f.p.quoteExpiresAt=new Date(Date.now()+60000).toISOString();let profiles=0;const calls=[];
  const reader=createLiveReadService({apiKey:'fixture',merchantId:'merchant',rpc:rpc(),fetcher:async(url,options)=>{assert.equal(options.method,'GET');calls.push(url);let data;if(url.endsWith('/me')){data=structuredClone(f.m);if(++profiles===2&&changed)data.merchantConfig.platformReferralFeeConfig.valueBps=600;}else if(url.endsWith('/payments'))data={payments:[f.p]};else data={merchant:{id:'merchant',environment:'LIVE'},order:f.o,currentPayment:f.p};return new Response(JSON.stringify({success:true,responseObject:data}));}});
  const result=await reader.refresh(f.l);assert.equal(!!result.verification.payIn.receiveEstimate,!changed,rail);assert.equal(calls.length,5);assert.equal(result.verification.payIn.paymentAuthorised,false);
 }
});
