import {merchantFeeKey} from './pay-net-estimate.mjs';
import {InputError} from './validation.mjs';
import {validateCheckout,sameUsdc} from './pay-contract.mjs';
import {verifyPayDelivery,EvidencePendingError} from './pay-delivery.mjs';
import {observePeerPayIn,observeCurrentSelection,payInSnapshotKey} from './pay-payin.mjs';
import {recipientHash} from './revolut-replacement-read.mjs';

const API='https://api.pay.peer.xyz/api/v1';
const identifier=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v);
export class TrackingReviewError extends Error {constructor(message,code='evidence_conflict'){super(message);this.code=code;}}
export class TrackingRetryError extends Error {constructor(seconds){super('Payment verification is temporarily unavailable.');this.retryAfterSeconds=seconds;}}

// Deliberately no create, signing, refund, payout or credential-discovery methods.
// The caller supplies an explicitly authorised connection; no environment fallback.
export function createLiveReadService({apiKey,merchantId,rpc,fetcher=fetch,corroborator=null}){
 if(!apiKey||!identifier(merchantId)||!rpc)throw Error('Live tracking requires an explicit merchant, read connection and receipt service.');
 async function read(path){
  const r=await fetcher(API+path,{method:'GET',headers:{'X-API-Key':apiKey},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(r.status===429){const seconds=Number(r.headers.get('x-retry-after')??r.headers.get('retry-after'));throw new TrackingRetryError(Number.isFinite(seconds)&&seconds>0?Math.min(3600,Math.ceil(seconds)):60);}
  if(!r.ok)throw Error('Provider read unavailable.');
  const b=await r.json();if(b?.success!==true||!b.responseObject)throw Error('Provider read unavailable.');
  return b.responseObject;
 }
 return Object.freeze({
  async refresh(order){
   if(order.source!=='live'||order.merchantId!==merchantId||!identifier(order.providerOrderId))throw new TrackingReviewError('Live order binding does not match this connection.');
   try{
    const merchant=await read('/merchants/me');
    if(merchant.environment!=='LIVE'||merchant.id!==merchantId)throw new TrackingReviewError('The merchant connection is not the bound live workspace.');
    const aggregate=await read('/orders/'+encodeURIComponent(order.providerOrderId));
    if(aggregate.merchant?.id!==merchantId||aggregate.merchant.environment!=='LIVE')throw new TrackingReviewError('The order belongs to a different workspace.');
    validateCheckout(aggregate.order,order,merchantId);
    if(!sameUsdc(order.requestedUsdcAmount,aggregate.order.requestedUsdcAmount))throw new TrackingReviewError('The original order amount changed.');
    const history=await read('/merchants/me/orders/'+encodeURIComponent(order.providerOrderId)+'/payments');
    // Conservatively hold bounded or explicitly paginated histories for review.
    if(!Array.isArray(history.payments)||history.payments.length>=100||history.hasMore||history.nextCursor||history.nextPage||history.pagination?.hasMore||history.pagination?.nextCursor||
      (history.totalCount!==undefined&&history.totalCount!==history.payments.length))throw new TrackingReviewError('The payment history is incomplete or exceeds the supported limit.');
    if(aggregate.currentPayment&&!history.payments.some(p=>p.id===aggregate.currentPayment.id&&p.status===aggregate.currentPayment.status))throw new EvidencePendingError('Payment reads have not converged.');
    const latest=await read('/orders/'+encodeURIComponent(order.providerOrderId));
    if(payInSnapshotKey(aggregate)!==payInSnapshotKey(latest))throw new EvidencePendingError('Payment changed during verification.');
    // Recheck fee configuration around active quote reads; a changed profile withholds only the estimate.
    const feeProfile=aggregate.currentPayment?.status==='CREATED'&&merchant.merchantConfig?await read('/merchants/me'):null;
    const verifiedFeeProfile=feeProfile&&merchantFeeKey(merchant)===merchantFeeKey(feeProfile)?merchant:null;
    const payIn=observePeerPayIn(order,aggregate,history.payments,{consistent:payInSnapshotKey(aggregate)===payInSnapshotKey(latest),merchant:verifiedFeeProfile});
    payIn.currentSelection=observeCurrentSelection(order,aggregate,history.payments,{consistent:true,merchant:verifiedFeeProfile});
    if(payInSnapshotKey(aggregate)===payInSnapshotKey(latest)&&aggregate.currentPayment?.rail==='revolut'&&aggregate.currentPayment.status==='CREATED')payIn.recipientHash=recipientHash(aggregate.currentPayment.payTo);
    const result=await verifyPayDelivery(order,aggregate.order,history.payments,{rpc});
    // Optional public-index corroboration cannot grant or revoke chain verification.
    if(corroborator)for(const payment of result.verification.payments.filter(p=>p.status==='SETTLED').slice(-1)){try{payment.indexer=await corroborator.lookup(payment.intentHash,payment.transactionHash);}catch{payment.indexer={status:'unavailable'};}}
    const selected=aggregate.currentPayment;
    if(selected&&selected.quoteExpiresAt!==history.payments.find(p=>p.id===selected.id)?.quoteExpiresAt)throw new EvidencePendingError('Payment expiry reads have not converged.');
    const currentAttempt=selected?{id:selected.id,status:selected.status,quoteExpiresAt:typeof selected.quoteExpiresAt==='string'&&Number.isFinite(Date.parse(selected.quoteExpiresAt))?new Date(selected.quoteExpiresAt).toISOString():null}:null;
    if(!['NONE','PARTIALLY_CHARGEBACKED','CHARGEBACKED'].includes(aggregate.order.chargebackStatus))throw new TrackingReviewError('Unknown dispute state.');
    return {...result,verification:{...result.verification,payIn,currentAttempt},checkedAt:result.verification.checkedAt,providerStatus:aggregate.order.status,chargebackStatus:aggregate.order.chargebackStatus};
   }catch(e){
    if(e instanceof TrackingReviewError||e instanceof EvidencePendingError||e instanceof TrackingRetryError)throw e;
    if(e instanceof InputError)throw new TrackingReviewError('Payment or receipt evidence conflicts with the saved order.',e.evidenceCode??'receipt_conflict');
    // Do not persist provider bodies, URLs, credentials or transport error text.
    throw Error('Payment verification is temporarily unavailable.');
   }
  }
 });
}
