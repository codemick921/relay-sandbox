import {createHash} from 'node:crypto';
import {validateCheckout,sameUsdc} from './pay-contract.mjs';
import {InputError} from './validation.mjs';
export const evidenceHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function recipientHash(value){
 if(typeof value!=='string')return null;
 const v=value.trim().toLowerCase().replace(/^@/,'');
 return /^[a-z0-9_.-]{1,100}$/.test(v)?evidenceHash(v):null;
}
// GET-only preflight; never exports raw provider data or a checkout access token.
export async function readUnpaidRevolut(local,{apiKey,merchantId,fetcher=fetch}){
 const read=async path=>{const r=await fetcher('https://api.pay.peer.xyz/api/v1'+path,{method:'GET',headers:{'X-API-Key':apiKey},redirect:'error',signal:AbortSignal.timeout(15000)});const b=await r.json();if(!r.ok||b.success!==true||!b.responseObject)throw new InputError('Payment history is unavailable.',503);return b.responseObject;};
 const path='/orders/'+encodeURIComponent(local.providerOrderId),a=await read(path);
 if(a.merchant?.id!==merchantId||a.merchant.environment!=='LIVE')throw new InputError('Payment workspace differs.',409);
 validateCheckout(a.order,local,merchantId);
 const h=await read('/merchants/me/orders/'+encodeURIComponent(local.providerOrderId)+'/payments'),latest=await read(path),p=a.currentPayment;
 if(evidenceHash(a)!==evidenceHash(latest)||a.order.status!=='CREATED'||a.order.chargebackStatus!=='NONE'||a.order.dynamicOrdersEnabled===true||a.order.buyerFeeShareBps!==0||!sameUsdc(a.order.remainingUsdcAmount,a.order.requestedUsdcAmount)||!sameUsdc(local.requestedUsdcAmount,a.order.requestedUsdcAmount)||!Array.isArray(h.payments)||h.payments.length!==1||h.hasMore||h.nextCursor||h.nextPage||h.pagination?.hasMore||h.pagination?.nextCursor||(h.totalCount!==undefined&&h.totalCount!==1)||!p||h.payments[0].id!==p.id||evidenceHash(h.payments[0])!==evidenceHash(p))throw new InputError('The first payment needs reconciliation before replacement.',409);
 if(p.orderId!==local.providerOrderId||p.status!=='CREATED'||p.rail!=='revolut'||p.currency!=='GBP'||!/^0(?:\.0+)?$/.test(p.paymentAmount??'')||p.netSettledUsdcAmount!==null||p.fulfillTransaction!==null||p.chargebackStatus!=='NONE'||!Array.isArray(p.penalties)||p.penalties.length||p.attestation||p.completedAt||!recipientHash(p.payTo))throw new InputError('The first payment is not confirmed unpaid.',409);
 return {hash:evidenceHash({order:a.order,payments:h.payments}),recipientHash:recipientHash(p.payTo),checkedAt:new Date().toISOString()};
}
