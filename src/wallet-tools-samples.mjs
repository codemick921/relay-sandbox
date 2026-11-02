// Browser-only demonstrations. No network, storage, credentials or wallet SDK.
import {fundingCatalog} from '../shared/fiat.mjs';
const buyer='0x0000000000000000000000000000000000000011';
const recipient='0x0000000000000000000000000000000000000022';
const token='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const fixed=n=>`${n/1000000n}.${String(n%1000000n).padStart(6,'0')}`;
export function sampleQuote(input,{now=Date.now(),context=null,review=false}={}){
 if(!/^\d+(\.\d{1,6})?$/.test(input?.amount??''))throw Object.assign(Error('Invalid target'),{status:400});
 const [whole,part='']=input.amount.split('.'),net=BigInt(whole)*1000000n+BigInt(part.padEnd(6,'0'));
 if(net<10000n||net>10000000000n)throw Object.assign(Error('Invalid target'),{status:400});
 const methods=fundingCatalog.methods.filter(m=>m.checkoutSupported&&m.currencies.includes(input.currency)&&(input.method==='all'||m.id===input.method));
 if(!methods.length)throw Object.assign(Error('Invalid method'),{status:400});
 // Deliberately invented, labelled sample rate. Never substitute for a provider quote.
 const fee=(net+99n)/100n,gross=net+fee;
 const rows=methods.map(m=>({method:m.id,status:'available',offers:[{
  id:`sample-${m.id}-${input.currency}-${input.amount}`,validUntil:Math.min(now+60000,context?.validUntil??Infinity),
  youPay:{currency:input.currency,displayAmount:(Number(gross)/1000000*.8).toFixed(2)},
  youReceive:{displayAmount:fixed(net)},fee:{displayAmount:fixed(fee)},
  conditions:{requiresStake:false,whitelisted:false},verification:'seller_release'
 }]}));
 const result={rows,checkedAt:now,route:'peer_direct',source:'fabricated_sample',sample:true,reserved:false,canCreatePayment:false,
  eligibility:context?'not_verified':'example_addresses',...(context?{addressBinding:'server_resolved',addressContext:context}:{})};
 if(!review)return result;
 const offer=rows.flatMap(r=>r.offers).find(o=>o.id===input.offerId);
 return {...result,status:offer?'terms_match':'offer_unavailable',offer:offer??null,readiness:{contract:'contract_not_verified',reservation:'disabled'}};
}
export function createWalletToolsSample({now=Date.now}={}){
 let wallet=null,context=null;
 return async(op,input)=>{
  if(op==='inspect')return wallet?{status:'found',wallet}:{status:'none'};
  if(op==='create'){wallet={address:buyer};return{status:'found',wallet};}
  if(op==='verify'){
   if(!wallet)return{status:'verificationFailed'};
   context={status:'addresses_ready',contextId:'browser-sample',validUntil:now()+60000,canCreatePayment:false,
    buyer:{address:buyer,chainId:8453},recipient:{id:'research',address:recipient,chainId:8453,token}};
   return{status:'verified',sample:true,expiresAt:context.validUntil,context};
  }
  if(['quotes','review'].includes(op)){
   if(!context||context.validUntil<=now()||input?.contextId!==context.contextId||input?.shareAddresses!==true)throw Error('sample_context_changed');
   return sampleQuote(input,{now:now(),context,review:op==='review'});
  }
  throw Error('Unsupported sample action');
 };
}
