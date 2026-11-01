import {checkoutRails,currencyCode,supportsFunding,knownCurrency,minimumMinor,methodLabel} from '../shared/fiat.mjs';
import {createLiveFunding} from './live-funding.mjs';
import {createLiveCheckoutWriter} from '../server/pay-live-create.mjs';
import {liveOrderView} from './live-store.mjs';
import {InputError} from '../server/validation.mjs';

// Explicit web-only composition. The worker and local preview never enable it.
export function createCustomerFunding({drafts,tracker,reader,connection,origin,fetcher=fetch}){
 if(connection?.environment!=='LIVE'||!origin?.startsWith('https://'))throw Error('Live funding requires a pinned live connection and HTTPS origin.');
 const authorise=async intent=>/^customer:/.test(intent.owner??'')&&supportsFunding(intent.quote?.platform,currencyCode(intent.quote?.currency))&&intent.agent?.network==='Base'&&intent.agent?.token==='USDC';
 const flows=Object.fromEntries(checkoutRails.map(rail=>[rail,createLiveFunding({drafts,tracker,reader,merchantId:connection.merchantId,origin,authorise,
  writer:createLiveCheckoutWriter({apiKey:connection.apiKey,merchantId:connection.merchantId,rail,maxPence:100000,fetcher,authorise:()=>true})})]));
 async function flow(owner,id){const row=await drafts.review(owner,id);if(row.tracking_only_at)throw new InputError('This paid request is tracking only. Do not pay its checkout again.',409);if(row.stopped_at)throw new InputError('This request was stopped in Eupova. Start a new funding request.',409);if(row.superseded_by)throw new InputError('This checkout was replaced. Open its replacement from your activity.',409);return flows[row.rail];}
 return Object.freeze({enabled:true,
  async stop(owner,input){
   if(input.confirmNoPayment!==true||Object.keys(input).some(k=>!['id','confirmNoPayment'].includes(k)))throw new InputError('Confirm you have not sent or scheduled any payment and will not use the old checkout.');
   const row=await drafts.review(owner,input.id);if(row.stopped_at)return {id:row.id};
   if(row.status!=='bound'||row.superseded_by)throw new InputError('This request must be reconciled before it can be stopped.',409);
   // A worker can finish between the read and the stop. Retry once with a wholly
   // fresh provider read; never reuse the old unpaid observation or bypass a hold.
   for(let attempt=0;attempt<2;attempt++){
    const tracked=await tracker.owned(owner,input.id),checked=await reader.refresh(liveOrderView(tracked));
    try{const result=await drafts.stop(owner,input.id,checked,tracked.generation);await tracker.schedule(owner,input.id);return result;}
    catch(e){if(attempt!==0||e.code!=='TRACKING_GENERATION_CHANGED')throw e;}
   }
  },
  async requestCancellation(owner,input){
   if(input.confirmNoPayment!==true||Object.keys(input).some(k=>!['id','confirmNoPayment'].includes(k)))throw new InputError('Confirm that you have not sent or scheduled any payment.');
   const row=await drafts.review(owner,input.id);
   if(row.status==='cancelled')return {id:row.id};
   if(row.status!=='bound'||row.superseded_by)throw new InputError('This request is not available for cancellation.',409);
   const checked=await reader.refresh(liveOrderView(await tracker.owned(owner,input.id)));
   const result=await drafts.requestCancellation(owner,input.id,checked);await tracker.schedule(owner,input.id);return result;
  },
  async start(owner,input){return (await flow(owner,input.id)).start(owner,input);},
  async checkout(owner,id){const f=await flow(owner,id);await tracker.schedule(owner,id);const checked=await reader.refresh(liveOrderView(await tracker.owned(owner,id)));
   if(!['checkout_ready','checkout_partial'].includes(checked.status)||checked.chargebackStatus!=='NONE')throw new InputError('This checkout is no longer ready for payment. Check its tracking status.',409);
   return f.checkout(owner,id);}
 });
}
