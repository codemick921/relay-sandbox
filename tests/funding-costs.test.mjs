import test from 'node:test';
import assert from 'node:assert/strict';
import {fundingCosts,inputPence} from '../src/funding-costs.mjs';
const now=1792920000000;
const row=(m,label)=>m.rows.find(r=>r.label===label)?.value;
const quote=()=>({schema:'peer-revolut-gbp-v1',status:'within_peer_limit',totalPence:194,checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString()});
const settled=()=>({expectedNetRaw:'5932590',receivedRaw:'5932590',payments:[{id:'one',status:'SETTLED',currency:'USD',amountRaw:'5932590',feeRaw:'308955',adjustments:[{kind:'CROSS_CURRENCY',penaltyBps:300,originalAmount:'6.67',attestedAmount:'6.46'}]}],payIn:{...quote(),status:'settled_other_currency',paymentId:'one',settlement:{currency:'USD',paymentAmount:'6.67',netUsdcRaw:'5932590',feeUsdcRaw:'308955'}}});
test('before a quote exists, requested GBP is separate and unknown costs never become zero',()=>{
 const m=fundingCosts({requestedPence:500});assert.equal(row(m,'Requested funding'),'£5.00');assert.equal(row(m,'Estimated Peer fee'),'Not available yet');assert.equal(row(m,'Estimated USDC to your wallet'),'Not available yet');assert.equal(row(m,'Last observed GBP quote'),'Not available yet');assert.equal(row(m,'Bank or payment-app fees'),'Not visible to Relay');assert.equal(row(m,'Confirmed wallet arrival'),undefined);
});
test('decimal GBP input accepts exact pence and rejects malformed intermediate input',()=>{
 assert.equal(inputPence('0.83'),83);assert.equal(inputPence('10.1'),1010);assert.equal(inputPence('0'),0);for(const s of ['',null,'5.','5.555','-2','2e3','NaN'])assert.equal(inputPence(s),null);assert.equal(row(fundingCosts({requestedPence:inputPence('')}),'Requested funding'),'Enter a valid GBP amount');
});
test('saved quote does not imply payment, fees or a net estimate; expiration advances without server refresh',()=>{
 const verification={payIn:quote(),requestedUsdcAmount:'999'};
 let m=fundingCosts({requestedPence:200,verification,now});assert.equal(row(m,'Last observed GBP quote'),'£1.94');assert.equal(row(m,'Requested funding'),'£2.00');assert.equal(row(m,'Estimated USDC to your wallet'),'Not available yet');assert.equal(m.status,'within_peer_limit');
 assert.equal(fundingCosts({verification,now:now+31000}).status,'stale');assert.equal(fundingCosts({verification,now:now+60000}).status,'quote_expired');assert.equal(fundingCosts({verification:{payIn:{...quote(),expiresAt:'invalid'}},now}).status,'quote_expired');
});
test('foreign-currency payment, adjustment, actual fee and net delivery remain distinct and exact',()=>{
 const m=fundingCosts({requestedPence:500,verification:settled(),now});assert.equal(row(m,'Requested funding'),'£5.00');assert.equal(row(m,'Payment recorded by Peer'),'6.67 USD');assert.equal(row(m,'Peer settlement fee'),'0.308955 USDC');assert.equal(row(m,'Net USDC settled by Peer'),'5.932590 USDC');assert.equal(row(m,'Confirmed wallet arrival'),'5.932590 USDC');assert.match(m.adjustments[0],/6.67 USD became 6.46 USD/);assert.equal(row(m,'Last observed GBP quote'),undefined);assert.equal(m.expiresAt,null);
});
test('settlement with no pay-in snapshot still displays fees from validated payment records',()=>{
 const v=settled();delete v.payIn;const m=fundingCosts({verification:v});assert.equal(row(m,'Peer settlement fee'),'0.308955 USDC');assert.match(m.message,/settled amounts/);assert.equal(row(m,'Payment recorded by Peer'),'Not available');
});
test('multi-payment totals sum exactly without treating one fiat observation as the total',()=>{
 const v=settled();v.payments.push({id:'two',status:'SETTLED',amountRaw:'1000001',feeRaw:'1',currency:'GBP'});v.expectedNetRaw='6932591';const m=fundingCosts({verification:v});assert.equal(row(m,'Peer settlement fee'),'0.308956 USDC');assert.equal(row(m,'Net USDC settled by Peer'),'6.932591 USDC');assert.equal(row(m,'Confirmed wallet arrival'),'5.932590 USDC');assert.equal(row(m,'Payment recorded by Peer'),'Not available');
});
test('recorded zero fees differ from unavailable fees; pending arrival zero remains zero',()=>{
 const v=settled();delete v.payIn;v.payments[0].feeRaw='0';v.receivedRaw='0';let m=fundingCosts({verification:v});assert.equal(row(m,'Peer settlement fee'),'0.000000 USDC');assert.equal(row(m,'Confirmed wallet arrival'),'0.000000 USDC');delete v.payments[0].feeRaw;m=fundingCosts({verification:v});assert.equal(row(m,'Peer settlement fee'),'Not available yet');assert.equal(row(m,'Net USDC settled by Peer'),'5.932590 USDC');
});
test('duplicate or inconsistent settlement evidence is never presented as a reliable amount',()=>{
 for(const edit of [v=>v.payments.push({...v.payments[0]}),v=>v.expectedNetRaw='1',v=>v.payIn.settlement.netUsdcRaw='1',v=>v.payIn.paymentId='other',v=>v.payments[0].amountRaw='bad']){
 const v=settled();edit(v);const m=fundingCosts({verification:v});assert.equal(m.conflict,true);assert.equal(row(m,'Net USDC settled by Peer'),'Not available yet');assert.equal(row(m,'Confirmed wallet arrival'),'Not confirmed');assert.match(m.message,/needs review/);}
});
test('stopped, review and unavailable tracking retain their warnings and simulation identity',()=>{
 const v=settled(),before=JSON.stringify(v),m=fundingCosts({verification:v,stopped:true,review:true,trackingError:true,simulated:true});assert.match(m.message,/Do not pay its old checkout/);assert.equal(m.simulated,true);assert.equal(m.trackingUnavailable,true);assert.equal(JSON.stringify(v),before);assert.match(fundingCosts({verification:v,review:true}).message,/needs review/);
});
test('malformed or absent evidence cannot crash rendering or fabricate amounts',()=>{
 for(const v of [null,{}, {payIn:{status:'within_peer_limit',totalPence:5}}, {payments:[null,{}],receivedRaw:'NaN'},{payIn:{...quote(),totalPence:undefined}}])assert.doesNotThrow(()=>fundingCosts({verification:v,now}));
 const v=settled();v.receivedRaw='999999999';assert.equal(row(fundingCosts({verification:v}),'Confirmed wallet arrival'),'Not confirmed');
});
