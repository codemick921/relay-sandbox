// Experimental quote-only component. No provider, wallet, database or network imports.
// Call only with server-owned policy and responses from an authenticated/origin-checked adapter.
import {createHash} from 'node:crypto';

export const BASE_USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const UINT_MAX=2n**256n-1n;
export class QuoteError extends Error {
 constructor(code){super(code);this.name='QuoteError';this.code=code;}
}
function requireThat(ok,code){if(!ok)throw new QuoteError(code);}
function addr(value){
 requireThat(typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value)&&!/^0x0{40}$/.test(value),'invalid_address');
 return value.toLowerCase();
}
function units(value,{zero=false}={}){
 requireThat(typeof value==='string'&&/^(0|[1-9]\d{0,77})$/.test(value),'invalid_units');
 const n=BigInt(value);requireThat(n<=UINT_MAX&&(zero?n>=0n:n>0n),'invalid_units');return n;
}
export function decimalUnits(value,precision=6){
 requireThat(typeof value==='string'&&value.length<=80&&/^(0|[1-9]\d*)(\.\d+)?$/.test(value),'invalid_decimal');
 const [whole,part='']=value.split('.');requireThat(part.length<=precision,'excess_precision');
 const n=BigInt(whole)*10n**BigInt(precision)+BigInt(part.padEnd(precision,'0')||'0');
 requireThat(n>0n&&n<=UINT_MAX,'invalid_decimal');return n.toString();
}
function display(raw,precision=6){
 const s=BigInt(raw).toString().padStart(precision+1,'0');
 return `${s.slice(0,-precision)}.${s.slice(-precision)}`;
}
function canonical(v){
 if(Array.isArray(v))return v.map(canonical);
 if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));
 return v;
}
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function time(now){requireThat(Number.isSafeInteger(now)&&now>=0,'invalid_clock');return now;}
function validatePolicy(policy){
 requireThat(policy&&Array.isArray(policy.routes)&&policy.routes.length>0&&Array.isArray(policy.escrows)&&policy.escrows.length>0&&Array.isArray(policy.orchestrators)&&policy.orchestrators.length>0,'missing_policy');
 requireThat(Number.isSafeInteger(policy.maxAgeMs)&&policy.maxAgeMs>=1000&&policy.maxAgeMs<=300000,'invalid_freshness_policy');
 requireThat(policy.routes.every(r=>typeof r.method==='string'&&/^[a-z][a-z0-9_]*$/.test(r.method)&&typeof r.currency==='string'&&/^[A-Z]{3}$/.test(r.currency)&&/^0x[0-9a-fA-F]{64}$/.test(r.currencyHash)),'invalid_routes');
 policy.escrows.forEach(addr);policy.orchestrators.forEach(addr);
}
export function buildQuoteRequest(input,policy){
 validatePolicy(policy);
 requireThat(['receive','pay'].includes(input?.amountMode),'invalid_amount_mode');
 requireThat(policy.routes.some(r=>r.method===input.method&&r.currency===input.currency),'unsupported_route');
 // Two-decimal fiat only until a per-currency provider precision policy is verified.
 const raw=input.amountMode==='receive'?decimalUnits(input.amount):String(BigInt(decimalUnits(input.amount,2))*10000n);
 requireThat(input.chainId===8453&&addr(input.token)===BASE_USDC,'unsupported_asset');
 const context={route:'peer_direct',amountMode:input.amountMode,amountRaw:raw,method:input.method,currency:input.currency,buyer:addr(input.buyer),recipient:addr(input.recipient),chainId:8453,token:BASE_USDC};
 const request={amount:raw,isExactFiat:input.amountMode==='pay',paymentPlatforms:[input.method],fiatCurrency:input.currency,user:context.buyer,recipient:context.recipient,destinationChainId:8453,destinationToken:BASE_USDC,mode:'eligible',quotePreference:'PREFER_SAR',referralFees:[],escrowAddresses:policy.escrows.map(addr),quotesToReturn:3};
 return freeze({context,request});
}
function rejectRow(q,context,orchestrator,policy){
 const i=q?.intent;
 requireThat(i&&q.paymentMethod===context.method&&i.processorName===context.method,'method_mismatch');
 requireThat(addr(i.toAddress)===context.recipient,'recipient_mismatch');
 requireThat(String(i.chainId)==='8453','chain_mismatch');
 requireThat(policy.escrows.map(addr).includes(addr(i.escrowAddress)),'unsupported_escrow');
 requireThat(!i.orchestratorAddress||addr(i.orchestratorAddress)===orchestrator,'orchestrator_mismatch');
 // Current public API intentionally omits maker identity; payee hash + deposit bind terms.
 requireThat(typeof q.whitelistEnabled==='boolean','eligibility_unknown');
 requireThat(typeof i.payeeDetails==='string'&&/^0x[0-9a-fA-F]{64}$/.test(i.payeeDetails),'missing_payee_hash');
 const route=policy.routes.find(r=>r.method===context.method&&r.currency===context.currency);
 requireThat(typeof i.fiatCurrencyCode==='string'&&i.fiatCurrencyCode.toLowerCase()===route.currencyHash.toLowerCase(),'currency_identity_mismatch');
 requireThat(typeof i.depositId==='string'||Number.isSafeInteger(i.depositId),'invalid_deposit');
 units(String(i.depositId),{zero:true});
 requireThat(typeof q.disputeProtectionRequiresStake==='boolean','stake_unknown');
 requireThat(typeof q.sellerAutomatedReleaseAvailable==='boolean','verification_unknown');
 const fiat=units(q.fiatAmount),net=units(q.tokenAmount),gross=units(q.signalIntentAmount),fee=units(q.totalFeeAmount,{zero:true});
 requireThat(units(i.amount)===gross&&gross>=net&&gross-net===fee,'inconsistent_fee_or_net');
 const rate=units(q.conversionRate),calculated=(gross*rate+10n**18n-1n)/10n**18n;
 requireThat(calculated>=fiat?calculated-fiat<=1n:fiat-calculated<=1n,'inconsistent_exchange_rate');
 requireThat(Number.isInteger(q.serviceFeeBps)&&q.serviceFeeBps>=0&&q.serviceFeeBps<10000,'fee_rate_missing');
 requireThat(q.takerReferralFeeBps===0&&units(q.takerReferralFeeAmount,{zero:true})===0n,'unexpected_referral_fee');
 const service=units(q.zkp2pFeeAmount,{zero:true}),manager=units(q.managerFeeAmount,{zero:true});
 const rateFee=gross*BigInt(q.serviceFeeBps)/10000n;
 requireThat(service+manager===fee&&(service>=rateFee?service-rateFee<=1n:rateFee-service<=1n),'inconsistent_fee_breakdown');
 const requested=units(context.amountRaw);
 if(context.amountMode==='receive')requireThat(net===requested,'target_mismatch');
 else requireThat(fiat<=requested&&(fiat+9999n)/10000n===requested/10000n,'budget_mismatch');
 return {fiat,net,gross,fee};
}
export function normaliseQuoteResponse(result,built,policy,{now=Date.now()}={}){
 validatePolicy(policy);time(now);
 // Rebuild validation so a caller cannot swap a valid request's context independently.
 const c=built.context;
 requireThat(c.route==='peer_direct','route_mismatch');
 requireThat(digest(built.request)===digest(buildQuoteRequest({amountMode:c.amountMode,amount:c.amountMode==='receive'?display(c.amountRaw):display(BigInt(c.amountRaw)/10000n,2),method:c.method,currency:c.currency,buyer:c.buyer,recipient:c.recipient,chainId:c.chainId,token:c.token},policy).request),'request_context_mismatch');
 const r=result?.responseObject;
 requireThat(result?.success===true&&r&&Array.isArray(r.quotes)&&r.quotes.length<=20,'invalid_provider_response');
 requireThat(r.token?.chainId===8453&&r.token.decimals===6&&addr(r.token.token)===BASE_USDC&&r.fiat?.currencyName===c.currency&&r.fiat?.currencyCode?.toLowerCase()===policy.routes.find(x=>x.method===c.method&&x.currency===c.currency).currencyHash.toLowerCase(),'response_asset_mismatch');
 const expires=Date.parse(r.quoteExpiresAt);
 requireThat(Number.isFinite(expires)&&expires>now+5000,'expired_quote');
 const orchestrator=addr(r.orchestratorAddress);
 requireThat(policy.orchestrators.map(addr).includes(orchestrator),'unsupported_orchestrator');
 const offers=[],rejections=[];
 for(const [index,q] of r.quotes.entries()){
  try{
   const {fiat,net,gross,fee}=rejectRow(q,c,orchestrator,policy);
   const terms={context:structuredClone(c),orchestrator,quote:{paymentMethod:q.paymentMethod,fiatAmount:q.fiatAmount,tokenAmount:q.tokenAmount,signalIntentAmount:q.signalIntentAmount,totalFeeAmount:q.totalFeeAmount,zkp2pFeeAmount:q.zkp2pFeeAmount,managerFeeAmount:q.managerFeeAmount,conversionRate:q.conversionRate,serviceFeeBps:q.serviceFeeBps,takerReferralFeeBps:q.takerReferralFeeBps,takerReferralFeeAmount:q.takerReferralFeeAmount,sellerAutomatedReleaseAvailable:q.sellerAutomatedReleaseAvailable,disputeProtectionRequiresStake:q.disputeProtectionRequiresStake,whitelistEnabled:q.whitelistEnabled,allowedGroupIds:q.allowedGroupIds??[],intent:structuredClone(q.intent)}};
   const fingerprint=digest(terms),fiatDigits=new Intl.NumberFormat('en-GB',{style:'currency',currency:c.currency}).resolvedOptions().maximumFractionDigits,roundingUnit=10n**BigInt(6-fiatDigits);
   const rounded=(fiat+roundingUnit-1n)/roundingUnit;
   if(offers.some(o=>o.fingerprint===fingerprint))continue;
   offers.push(freeze({fingerprint,terms,checkedAt:now,providerExpiresAt:expires,validUntil:Math.min(expires,now+policy.maxAgeMs),
    youPay:{currency:c.currency,providerAmountRaw:fiat.toString(),providerDecimalAmount:display(fiat),displayAmount:fiatDigits?display(rounded,fiatDigits):String(rounded),displayRounding:'ceiling_to_currency_minor_unit',exactPaymentAmountVerified:false,label:'Estimated payment'},
    youReceive:{asset:'USDC',chainId:8453,token:BASE_USDC,amountRaw:net.toString(),displayAmount:display(net)},
    fee:{asset:'USDC',amountRaw:fee.toString(),displayAmount:display(fee),includedInNet:true},grossAmountRaw:gross.toString(),
    conditions:{requiresStake:q.disputeProtectionRequiresStake,whitelisted:q.whitelistEnabled,buyerEligibilityVerified:false},
    exchangeRate:{raw:q.conversionRate,decimals:18,unit:`${c.currency}/USDC`},spreadBps:null,externalChargesKnown:false,
    verification:q.sellerAutomatedReleaseAvailable?'seller_release':'buyer_verification',reserved:false,canExecute:false}));
  }catch(e){if(!(e instanceof QuoteError))throw e;rejections.push({index,code:e.code});}
 }
 return freeze({status:offers.length?'quotes_available':rejections.length?'evidence_incomplete':'no_quotes',context:structuredClone(c),offers,rejections,checkedAt:now,canCreatePayment:false});
}
export function reviewSelection(selected,refreshed,{now=Date.now()}={}){
 time(now);
 requireThat(selected?.fingerprint&&digest(selected.terms)===selected.fingerprint,'invalid_selection');
 requireThat(refreshed&&Array.isArray(refreshed.offers),'invalid_refresh');
 requireThat(digest(selected.terms.context)===digest(refreshed.context),'context_changed');
 const exact=refreshed.offers.find(q=>q.fingerprint===selected.fingerprint);
 if(!exact)return {status:refreshed.offers.length?'review_changed_offer':'offer_unavailable',canExecute:false};
 requireThat(digest(exact.terms)===exact.fingerprint,'invalid_refreshed_selection');
 if(exact.checkedAt>now||exact.validUntil<=now)return {status:'refresh_required',canExecute:false};
 // This is a comparison only. Authenticated consent + validated reservation remain separate.
 return {status:'terms_match',quote:exact,reserved:false,canExecute:false};
}
