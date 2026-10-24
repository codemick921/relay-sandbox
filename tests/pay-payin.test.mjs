import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {computeDisplayedFiatAmount} from '@zkp2p/pay-shared';
import {observePeerPayIn,payInProjection} from '../server/pay-payin.mjs';
import {createLiveReadService} from '../server/pay-readonly.mjs';
import {local,remote,payment,rpc} from './fixtures/live-evidence.mjs';
const now=1792860000000;
function sample(){
 const l={...local(),requestedUsdcAmount:'12.5',quote:{pence:1000,platform:'wise'}};
 const p={...payment(),status:'CREATED',paymentAmount:'0',netSettledUsdcAmount:null,totalUsdcFeeAmount:'0',currencyPerUsdRate:'0.8',quoteExpiresAt:new Date(now+60000).toISOString()};
 p.quote={...p.quote,sellerAutomatedReleaseAvailable:true,conversionRate:'0.91'};
 const a={merchant:{id:'merchant',environment:'LIVE'},order:{...remote(),status:'CREATED',remainingUsdcAmount:'12.5',requestedFiat:{amount:'10',currency:'GBP'},dynamicOrdersEnabled:false},currentPayment:p};
 return {l,a,p,h:[structuredClone(p)]};
}
const evaluate=f=>observePeerPayIn(f.l,f.a,f.h,{now});
function editPayment(f,fn){fn(f.p);f.h=[structuredClone(f.p)];}

test('real merchant-pays fields produce a GBP observation without authorising any payment',()=>{
 const f=sample(),v=evaluate(f);assert.equal(v.status,'within_peer_limit');assert.equal(v.totalPence,1000);assert.equal(v.conservativePence,'1000');assert.equal(v.paymentAuthorised,false);assert.equal(v.allInLimitVerified,false);assert.equal(v.externalBankCharges,'not_observable');assert.equal(v.settlement,null);
 editPayment(f,p=>{p.quote.amountAdjustment={buyerFiatAmount:'99.00'};p.quote.conversionRate='999';p.payIn={includesAllFees:true};});assert.equal(evaluate(f).totalPence,1000);
 f.a.currentPayment=null;f.h=[];const waiting=evaluate(f);assert.equal(waiting.status,'awaiting_selection');assert.equal(waiting.totalPence,null);
});

test('decimal boundary and official display parity never round an over-limit raw value into approval',()=>{
 const f=sample();f.a.order.remainingUsdcAmount='12.500001';const v=evaluate(f);assert.equal(v.totalPence,1000);assert.equal(v.conservativePence,'1001');assert.equal(v.status,'over_limit');
 f.a.order.remainingUsdcAmount='12.4875';assert.equal(evaluate(f).totalPence,999);
 for(const value of ['1e1',' 10','+10','-0','NaN','10.','10.0000001','1'.repeat(100)]){f.a.order.remainingUsdcAmount=value;assert.equal(evaluate(f).status,'malformed_amount',value);}
 const args={feePayer:'MERCHANT',remainingUsdcAmount:'12.5',currencyPerUsdRate:'0.8',paymentAmountFallback:'0',signalIntentAmountBaseUnits:'12500000',conversionRateDecimal:'0.91'};
 assert.equal(computeDisplayedFiatAmount(args),'10.00');assert.equal(computeDisplayedFiatAmount({...args,feePayer:'PAYEE'}),'11.38');
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.resolve('@zkp2p/pay-shared'))));assert.equal(pkg.version,'8.0.0');
});

test('quote expiry, unavailable seller verification, wrong rail, currency and snapshot races remain blocked',()=>{
 for(const [change,status] of [[p=>p.rail='paypal','unsupported_payment'],[p=>p.currency='EUR','unsupported_payment'],[p=>p.quote.crossCurrency={sendAmount:'10',sendCurrency:'GBP'},'unsupported_payment'],[p=>p.quote.sellerAutomatedReleaseAvailable=false,'seller_verification_unconfirmed'],[p=>delete p.quote.sellerAutomatedReleaseAvailable,'seller_verification_unconfirmed'],[p=>p.quoteExpiresAt=new Date(now).toISOString(),'quote_expired'],[p=>p.quoteExpiresAt='bad','expiry_unavailable'],[p=>p.paymentAmount='10','snapshot_changed']]){const f=sample();editPayment(f,change);assert.equal(evaluate(f).status,status);}
 const f=sample();f.h[0].currencyPerUsdRate='0.7';assert.equal(evaluate(f).status,'snapshot_changed');assert.equal(observePeerPayIn(f.l,f.a,f.h,{now,consistent:false}).status,'snapshot_changed');
 const a=sample();a.a.order.dynamicOrdersEnabled=true;assert.equal(evaluate(a).status,'unsupported_order');a.a.order.feePayer='PAYEE';assert.equal(evaluate(a).status,'unsupported_order');
});

test('multiple attempts and changed selected quotes stay held across subsequent reads',()=>{
 const f=sample();f.h.push({...f.p,id:'old',status:'CANCELLED'});assert.equal(evaluate(f).status,'multiple_attempts');
 const g=sample(),first=evaluate(g);g.l.verification={payIn:first};editPayment(g,p=>p.currencyPerUsdRate='0.79');const changed=evaluate(g);assert.equal(changed.status,'quote_changed');g.l.verification.payIn=changed;assert.equal(evaluate(g).status,'quote_changed');
 const h=sample();h.l.verification={payIn:first};editPayment(h,p=>p.id='replacement');assert.equal(evaluate(h).status,'payment_changed');
});

test('actual fiat payment, settlement fee and net USDC remain distinct, including zero-fee and overpayment',()=>{
 const f=sample();editPayment(f,p=>{p.status='SETTLED';p.paymentAmount='10.00';p.netSettledUsdcAmount='11.88125';p.totalUsdcFeeAmount='0.61875';});f.a.order.remainingUsdcAmount='0';
 let v=evaluate(f);assert.equal(v.status,'settled_observation');assert.deepEqual(v.settlement,{paidPence:'1000',paymentAmount:'10.00',currency:'GBP',adjustments:[],netUsdcRaw:'11881250',feeUsdcRaw:'618750',feeExcludesSpread:true});assert.equal(v.allInLimitVerified,false);
 editPayment(f,p=>p.paymentAmount='10.01');assert.equal(evaluate(f).status,'over_limit');
 editPayment(f,p=>p.paymentAmount='0');assert.equal(evaluate(f).status,'malformed_amount');
 editPayment(f,p=>{p.paymentAmount='10';p.totalUsdcFeeAmount='0';});assert.equal(evaluate(f).settlement.feeUsdcRaw,'0');
 editPayment(f,p=>p.totalUsdcFeeAmount=null);assert.equal(evaluate(f).status,'malformed_amount');
});

test('stored observations expire in presentation and cannot authorise via injected flags',()=>{
 const f=sample(),v=evaluate(f);assert.equal(payInProjection(v,now+31000).status,'stale');assert.equal(payInProjection(v,now+60001).status,'quote_expired');
 const injected=payInProjection({...v,paymentAuthorised:true,allInLimitVerified:true,externalBankCharges:'0'},now);assert.equal(injected.paymentAuthorised,false);assert.equal(injected.allInLimitVerified,false);assert.equal(injected.externalBankCharges,'not_observable');
});

test('trusted reader connects actual fields using reads only and detects repricing between requests',async()=>{
 for(const change of [false,true]){const f=sample();f.p.quoteExpiresAt=new Date(Date.now()+60000).toISOString();f.h=[structuredClone(f.p)];let orderReads=0;const calls=[];
 const reader=createLiveReadService({apiKey:'fixture',merchantId:'merchant',rpc:rpc(),fetcher:async(url,opts)=>{assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');calls.push(url);let body;if(url.endsWith('/me'))body={id:'merchant',environment:'LIVE'};else if(url.endsWith('/payments'))body={payments:f.h};else {body=structuredClone(f.a);if(++orderReads===2&&change)body.order.remainingUsdcAmount='12.6';}return new Response(JSON.stringify({success:true,responseObject:body}));}});
 const result=await reader.refresh(f.l);assert.equal(result.verification.payIn.status,change?'snapshot_changed':'within_peer_limit');assert.equal(result.delivery,null);assert.equal(calls.length,4);
 }
});

test('foreign-currency settlement is observed without relabelling it GBP or authorising another debit',()=>{
 const f=sample();editPayment(f,p=>{p.status='SETTLED';p.currency='USD';p.paymentAmount='6.67';p.netSettledUsdcAmount='5.93259';p.totalUsdcFeeAmount='0.308955';p.penalties=[{kind:'CROSS_CURRENCY',penaltyBps:300,originalAmount:'6.67',attestedAmount:'6.46'}];});
 f.a.order.status='FULFILLED';f.a.order.remainingUsdcAmount='0.02';
 const v=evaluate(f);assert.equal(v.status,'settled_other_currency');assert.equal(v.totalPence,null);assert.equal(v.settlement.paidPence,null);assert.equal(v.settlement.currency,'USD');assert.equal(v.settlement.paymentAmount,'6.67');assert.equal(v.settlement.netUsdcRaw,'5932590');assert.equal(v.settlement.feeUsdcRaw,'308955');assert.equal(v.paymentAuthorised,false);assert.equal(v.allInLimitVerified,false);
});
