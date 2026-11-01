import {paymentRecord} from '../../hosted/payment-records.mjs';
import {local,remote,payment,rpc} from './live-evidence.mjs';
import {verifyPayDelivery} from '../../server/pay-delivery.mjs';
export const now=Date.parse('2026-11-01T22:00:00Z');
export function offer(order,overrides={}){
 return {schema:'peer-fiat-v2',status:'within_peer_limit',providerOrderId:order.providerOrderId,paymentId:'payment-1',currency:'GBP',rail:'wise',totalPence:2500,checkedAt:'2026-11-01T21:01:00Z',expiresAt:'2026-11-01T21:05:00Z',quoteFingerprint:'a'.repeat(64),receiveEstimate:{schema:'peer-standard-pro-net-v2',basis:'selected_offer_standard_pro',conditional:true,spreadIncluded:true,feeBps:495,feeConfigFingerprint:'b'.repeat(64),currency:'GBP',rail:'wise',offerRate:'0.80',grossUsdcRaw:'12500000',netUsdcRaw:'11881250',feeUsdcRaw:'618750'},...overrides};
}
export async function comparisonFixture({net='11.88125',fee='0.61875'}={}){
 const o={...local(),id:'11111111-1111-4111-8111-111111111111',createdAt:'2026-11-01T21:00:00Z',quote:{...local().quote,currency:'GBP'}};
 const p={...payment(),netSettledUsdcAmount:net,totalUsdcFeeAmount:fee};
 const {receipt}=await import('./live-evidence.mjs');
 const update=await verifyPayDelivery(o,remote(),[p],{rpc:rpc({getTransactionReceipt:async()=>receipt(p)}),now});
 const order={...o,...update};order.verification.payIn={schema:'peer-fiat-v2',paymentId:p.id,settlement:{paymentAmount:'25.00',currency:'GBP',netUsdcRaw:order.verification.payments[0].amountRaw,feeUsdcRaw:order.verification.payments[0].feeRaw}};
 return {order,selected:offer(order),record:(snapshots=[offer(order)])=>paymentRecord(order,null,now,snapshots)};
}
