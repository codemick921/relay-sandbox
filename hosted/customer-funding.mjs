import {createLiveFunding} from './live-funding.mjs';
import {createLiveCheckoutWriter} from '../server/pay-live-create.mjs';
import {liveOrderView} from './live-store.mjs';
import {InputError} from '../server/validation.mjs';

// Explicit web-only composition. The worker and local preview never enable it.
export function createCustomerFunding({drafts,tracker,reader,connection,origin,fetcher=fetch}){
 if(connection?.environment!=='LIVE'||!origin?.startsWith('https://'))throw Error('Live funding requires a pinned live connection and HTTPS origin.');
 const authorise=async intent=>/^customer:/.test(intent.owner??'')&&['wise','revolut'].includes(intent.quote?.platform)&&intent.agent?.network==='Base'&&intent.agent?.token==='USDC';
 const flows=Object.fromEntries(['wise','revolut'].map(rail=>[rail,createLiveFunding({drafts,tracker,reader,merchantId:connection.merchantId,origin,authorise,
  writer:createLiveCheckoutWriter({apiKey:connection.apiKey,merchantId:connection.merchantId,rail,maxPence:100000,fetcher,authorise:()=>true})})]));
 async function flow(owner,id){const row=await drafts.review(owner,id);if(row.superseded_by)throw new InputError('This checkout was replaced. Open its replacement from your activity.',409);return flows[row.rail];}
 return Object.freeze({enabled:true,
  async start(owner,input){return (await flow(owner,input.id)).start(owner,input);},
  async checkout(owner,id){const f=await flow(owner,id);await tracker.schedule(owner,id);const checked=await reader.refresh(liveOrderView(await tracker.owned(owner,id)));
   if(!['checkout_ready','checkout_partial'].includes(checked.status)||checked.chargebackStatus!=='NONE')throw new InputError('This checkout is no longer ready for payment. Check its tracking status.',409);
   return f.checkout(owner,id);}
 });
}
