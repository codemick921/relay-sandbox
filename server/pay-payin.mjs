import {settlementAdjustments} from './pay-delivery.mjs';
import {createHash} from 'node:crypto';
import {computeDisplayedFiatAmount} from '@zkp2p/pay-shared';

// Observations only. Neither an order input nor this result authorises a debit.
const SCHEMA='peer-wise-gbp-v1', TTL=30000;
const decimal=(value,places)=>{
 if(typeof value!=='string'||value.length>48||!new RegExp(`^(0|[1-9]\\d{0,15})(\\.\\d{1,${places}})?$`).test(value))throw Error('malformed_amount');
 const [whole,fraction='']=value.split('.');return BigInt(whole)*10n**BigInt(places)+BigInt(fraction.padEnd(places,'0'));
};
const pence=value=>decimal(value,2);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function payInProjection(evidence,now=Date.now()){
 if(!evidence||![SCHEMA,'peer-revolut-gbp-v1'].includes(evidence.schema))return null;
 const e={...evidence,paymentAuthorised:false,allInLimitVerified:false,externalBankCharges:'not_observable'};
 if(e.status==='within_peer_limit'){
  if(Date.parse(e.expiresAt)<=now)e.status='quote_expired';
  else if(!Number.isFinite(Date.parse(e.checkedAt))||now-Date.parse(e.checkedAt)>TTL||Date.parse(e.checkedAt)>now+5000)e.status='stale';
 }
 return e;
}
export function observePeerPayIn(local,aggregate,history,{now=Date.now(),consistent=true}={}){
 const rail=local.quote.platform;
 const base={schema:rail==='revolut'?'peer-revolut-gbp-v1':SCHEMA,currency:'GBP',rail,limitPence:local.quote.pence,
  checkedAt:new Date(now).toISOString(),providerOrderId:local.providerOrderId,paymentAuthorised:false,allInLimitVerified:false,
  externalBankCharges:'not_observable',feeMode:'MERCHANT',feeTreatment:'deducted_from_usdc_settlement',
  totalPence:null,settlement:null};
 const out=(status,details={})=>({...base,status,...details});
 try{
  const priorObservation=local.verification?.payIn;
  if(!history?.some(p=>p.status==='SETTLED')&&['quote_changed','payment_changed','multiple_attempts'].includes(priorObservation?.status))return {...priorObservation,checkedAt:base.checkedAt,paymentAuthorised:false,allInLimitVerified:false};
  const order=aggregate.order, current=aggregate.currentPayment;
  if(!consistent)return out('snapshot_changed');
  if(aggregate.merchant?.environment!=='LIVE'||aggregate.merchant.id!==local.merchantId||order?.id!==local.providerOrderId||order.merchantId!==local.merchantId||order.feePayer!=='MERCHANT'||order.amountMode!=='FIXED'||order.dynamicOrdersEnabled===true||order.buyerFeeShareBps!=null&&order.buyerFeeShareBps!==0||order.bridgeInfo||String(order.destinationChainId)!=='8453'||!same(order.destinationAddress,local.agent.address)||order.enabledRails?.length!==1||!['wise','revolut'].includes(rail)||order.enabledRails[0]!==rail)return out('unsupported_order');
  if(!Array.isArray(history)||history.length>1)return out('multiple_attempts');
  if(current===null&&history.length===0)return out('awaiting_selection');
  if(!current||history.length!==1||current.id!==history[0].id||current.orderId!==order.id)return out('snapshot_changed');
  const payment=history[0],quote=payment.quote,signal=quote?.signalIntent;
  // Compare all pricing fields across independent provider reads; never use a webhook body here.
  const fields=p=>[p.id,p.orderId,p.status,p.rail,p.currency,p.currencyPerUsdRate,p.paymentAmount,p.quoteExpiresAt,p.quote,p.netSettledUsdcAmount,p.totalUsdcFeeAmount];
  if(fingerprint(fields(current))!==fingerprint(fields(payment)))return out('snapshot_changed');
  if(payment.orderId!==order.id||payment.rail!==rail||!['GBP','USD','EUR'].includes(payment.currency)||!signal||signal.processorName!==rail||!same(signal.toAddress,local.agent.address))return out('unsupported_payment');
  const details={paymentId:payment.id,expiresAt:payment.quoteExpiresAt,sellerVerificationAvailable:quote.sellerAutomatedReleaseAvailable===true};
  if(payment.status==='SETTLED'){
   const paid=pence(payment.paymentAmount),net=decimal(payment.netSettledUsdcAmount,6),fee=decimal(payment.totalUsdcFeeAmount,6);
   if(paid<=0n||paid>BigInt(Number.MAX_SAFE_INTEGER)||net<=0n)return out('malformed_amount',details);
   const settlement={paidPence:payment.currency==='GBP'?String(paid):null,paymentAmount:payment.paymentAmount,currency:payment.currency,netUsdcRaw:String(net),feeUsdcRaw:String(fee),adjustments:settlementAdjustments(payment.penalties??[]),feeExcludesSpread:true};
   if(payment.currency!=='GBP')return out('settled_other_currency',{...details,totalPence:null,settlement});
   const previous=local.verification?.payIn;
   const changed=previous?.paymentId&&previous.paymentId!==payment.id;
   const amountChanged=previous?.quoteFingerprint&&previous.totalPence!==null&&BigInt(previous.totalPence)!==paid;
   return out(changed?'payment_changed':paid>BigInt(base.limitPence)?'over_limit':amountChanged?'paid_amount_changed':'settled_observation',{...details,totalPence:Number(paid),settlement});
  }
  if(payment.currency!=='GBP'||quote?.crossCurrency!=null)return out('unsupported_payment',details);
  if(payment.status!=='CREATED')return out('inactive_attempt',details);
  if(pence(payment.paymentAmount)!==0n||payment.netSettledUsdcAmount!=null)return out('snapshot_changed',details);
  if(rail==='wise'&&quote.sellerAutomatedReleaseAvailable!==true)return out('seller_verification_unconfirmed',details);
  const expiry=Date.parse(payment.quoteExpiresAt);
  if(!Number.isFinite(expiry))return out('expiry_unavailable',details);
  if(expiry<=now+5000)return out('quote_expired',details);
  const remaining=decimal(order.remainingUsdcAmount,6),rate=decimal(payment.currencyPerUsdRate,18);
  if(remaining<=0n||rate<=0n)return out('malformed_amount',details);
  // Merchant-pays uses the market peg, not signal amount times the seller rate.
  const numerator=remaining*rate*100n,denominator=10n**24n;
  const floor=numerator/denominator,ceiling=(numerator+denominator-1n)/denominator;
  const display=computeDisplayedFiatAmount({feePayer:'MERCHANT',remainingUsdcAmount:order.remainingUsdcAmount,currencyPerUsdRate:payment.currencyPerUsdRate,paymentAmountFallback:payment.paymentAmount,signalIntentAmountBaseUnits:null,conversionRateDecimal:null});
  const displayed=pence(display);
  if(displayed!==floor&&displayed!==ceiling||displayed<=0n)return out('display_mismatch',details);
  if(displayed>BigInt(Number.MAX_SAFE_INTEGER))return out('malformed_amount',details);
  const quoteFingerprint=fingerprint([order.id,payment.id,order.remainingUsdcAmount,payment.currencyPerUsdRate,payment.quoteExpiresAt,quote,order.feePayer]);
  const prior=local.verification?.payIn;
  const pricing={...details,totalPence:Number(displayed),conservativePence:String(ceiling),quoteFingerprint,amountSource:'peer_shared_8_merchant_market_peg'};
  if(prior?.paymentId&&prior.paymentId!==payment.id)return out('payment_changed',pricing);
  if(prior?.quoteFingerprint&&prior.quoteFingerprint!==quoteFingerprint)return out('quote_changed',pricing);
  if(ceiling>BigInt(base.limitPence))return out('over_limit',pricing);
  return out('within_peer_limit',pricing);
 }catch{return out('malformed_amount');}
}

// Compare the documented pricing/binding fields only; no seller details are persisted.
export const payInSnapshotKey=aggregate=>fingerprint([aggregate.merchant,aggregate.order,aggregate.currentPayment]);
