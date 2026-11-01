import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentRecord,renderRecord} from '../hosted/payment-records.mjs';
import {comparisonFixture,offer,now} from './fixtures/cost-comparison.mjs';
import {checkoutRails,fundingCatalog} from '../shared/fiat.mjs';

test('a historical selected offer matches final receipt using exact micro-USDC without requiring a still-live quote',async()=>{
 const f=await comparisonFixture(),before=JSON.stringify(f.order),r=f.record(),c=r.costComparison;
 assert.equal(r.deliveryConfirmed,true);assert.equal(c.status,'matched');assert.equal(c.differenceUsdc,'0.000000');assert.equal(c.offer.pay,'25.00 GBP');assert.equal(c.actualUsdc,'11.881250');assert.equal(JSON.stringify(f.order),before);
});
test('difference is decomposed once into converted amount and Peer fee; tiny differences are not silently rounded away',async()=>{
 for(const [args,delta] of [[{net:'11.88',fee:'0.62'},'-0.001250'],[{net:'11.881249',fee:'0.618751'},'-0.000001'],[{net:'12',fee:'0.5'},'0.118750']]){
  const c=(await comparisonFixture(args)).record().costComparison;assert.equal(c.status,'different');assert.equal(c.differenceUsdc,delta);assert.match(c.breakdown[0],/unchanged/);assert.match(c.breakdown[1],/Recorded Peer fee/);assert.ok(!c.explanation.includes('rounding'));
 }
 const f=await comparisonFixture({net:'11',fee:'0.5'}),c=f.record().costComparison;assert.equal(c.differenceUsdc,'-0.881250');assert.match(c.breakdown[0],/1.000000 USDC less/);assert.match(c.breakdown.at(-1),/does not establish why/);
});
test('missing fee is unknown rather than zero; zero fee remains a real value',async()=>{
 const f=await comparisonFixture({net:'12',fee:'0.5'});delete f.order.verification.payments[0].feeRaw;let c=f.record().costComparison;assert.equal(c.status,'different');assert.match(c.breakdown[0],/unavailable or inconsistent/);
 const z=await comparisonFixture({net:'12.5',fee:'0'});c=z.record().costComparison;assert.match(c.breakdown[1],/0.618750 USDC less/);
});
test('pending, review, simulation and multiple-payment records never report a final shortfall',async()=>{
 for(const mutate of [o=>{o.delivery=null;o.status='checkout_confirming';o.verification.payments[0].receipt.finalized=false;o.verification.payments[0].deliveryStatus='confirming';},o=>{o.reviewRequired=true;},o=>{o.fixture=true;},o=>{o.verification.payments.push({...o.verification.payments[0],id:'payment-2'});},o=>{o.verification.payments[0].currency='USD';}]){
  const f=await comparisonFixture();mutate(f.order);const c=f.record().costComparison;assert.equal(c.differenceUsdc,null);assert.ok(['pending','review','simulation','unavailable'].includes(c.status));
 }
});
test('wrong payment, order, rail, currency, timing or estimate arithmetic cannot supply a baseline',async()=>{
 const f=await comparisonFixture();
 const changes=[e=>e.paymentId='another',e=>e.providerOrderId='another',e=>e.rail='revolut',e=>e.currency='USD',e=>e.checkedAt='bad',e=>e.checkedAt='2026-11-02T00:00:00Z',e=>e.checkedAt='2026-10-01T00:00:00Z',e=>e.expiresAt=e.checkedAt,e=>e.totalPence=2501,e=>e.status='quote_changed',e=>e.quoteFingerprint=null,e=>e.receiveEstimate.netUsdcRaw='11881251',e=>e.receiveEstimate.spreadIncluded=false,e=>e.receiveEstimate.feeConfigFingerprint=null,e=>e.receiveEstimate.feeBps=0];
 for(const change of changes){const e=offer(f.order);change(e);assert.equal(f.record([e]).costComparison.offer,null);}
 assert.equal(f.record([]).costComparison.status,'unavailable');assert.equal(f.record(Array(101).fill(offer(f.order))).costComparison.offer,null);
});
test('matching currentSelection is used; later replacement is chosen, conflicting simultaneous snapshots withheld',async()=>{
 const f=await comparisonFixture(),first=offer(f.order),later=offer(f.order,{checkedAt:'2026-11-01T21:02:00Z',quoteFingerprint:'c'.repeat(64)});
 assert.equal(f.record([{currentSelection:later},first]).costComparison.offer.observedAt,new Date(later.checkedAt).toISOString());
 assert.equal(f.record([{...later,quoteFingerprint:'d'.repeat(64)},later]).costComparison.status,'unavailable');
 const expired={...first,paymentId:'expired-attempt'};assert.equal(f.record([expired,first]).costComparison.status,'matched');
});
test('comparison is available for all supported method/currency pairs without conversion between fiat currencies',async()=>{
 const f=await comparisonFixture();let count=0;
 for(const rail of checkoutRails)for(const currency of fundingCatalog.methods.find(m=>m.id===rail).currencies){
  const o=structuredClone(f.order);o.quote.platform=rail;o.quote.currency=currency;o.verification.payments[0].currency=currency;
  const e=offer(o,{rail,currency});e.receiveEstimate.rail=rail;e.receiveEstimate.currency=currency;
  const c=paymentRecord(o,null,now,[e]).costComparison;assert.equal(c.status,'matched');assert.equal(c.offer.currency,currency);count++;
 }
 assert.equal(count,60);
});
test('receipt exports share the comparison, escape values and retain dispute/outage caveats',async()=>{
 const f=await comparisonFixture();f.order.chargebackStatus='CHARGEBACKED';f.order.trackingError='secret diagnostic';const r=f.record(),c=r.costComparison;
 assert.equal(c.status,'matched');assert.ok(c.notes.some(x=>x.includes('dispute')));assert.ok(c.notes.some(x=>x.includes('temporarily unavailable')));
 for(const format of ['html','csv']){const out=renderRecord(r,format);assert.match(out,/Arrival matches/);assert.match(out,/11.881250/);assert.ok(!out.includes('secret diagnostic'));assert.ok(!out.includes('feeConfigFingerprint'));}
});


test('actual fiat is shown only for the same settled payment; changed amounts are explained without bank-fee claims',async()=>{
 const f=await comparisonFixture();f.order.verification.payIn.settlement.paymentAmount='24.99';let c=f.record().costComparison;
 assert.equal(c.actualFiat,'24.99 GBP');assert.equal(c.fiatDifference,'-0.01');assert.ok(c.notes.some(x=>x.includes('0.01 GBP less')));
 f.order.verification.payIn.paymentId='different-payment';c=f.record().costComparison;assert.equal(c.actualFiat,null);assert.equal(c.fiatDifference,null);
});
