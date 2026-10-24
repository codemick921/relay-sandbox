import {createLiveTrackingHandler} from './live-http.mjs';
// Explicit composition for a future controlled test. Never imported by runtime entrypoints.
// Tests supply mock provider/RPC transports; no flag or environment variable activates this.
import {InputError} from '../server/validation.mjs';
import {fundingIntent} from './funding-drafts.mjs';
import {createLiveWorker} from './live-worker.mjs';
export function createLiveFunding({drafts,tracker,writer,reader,merchantId,origin,authorise=()=>false}){
 const permit=async row=>{if(await authorise({...fundingIntent(row),owner:row.owner})!==true)throw new InputError('Live payment creation is disabled.',403);};
 return Object.freeze({
  async start(owner,{id,confirm,consent,...extra}){
   if(confirm!==true||consent!==true||Object.keys(extra).length)throw new InputError('Review the amount and destination and confirm sharing them with Peer.');
   const original=await drafts.review(owner,id);await permit(original);
   const claim=await drafts.claim(owner,id,merchantId);if(!claim)return {id,attempted:false};
   try{await permit(claim);const result=await writer.create(fundingIntent(claim),origin);return await drafts.bind(claim,result,tracker);}
   catch{await drafts.unresolved(claim);return {id,unresolved:true};}
  },
  async reconcile(owner,id,providerId){const claim=await drafts.attempted(owner,id);await permit(claim);const result=await writer.reconcile(fundingIntent(claim),providerId,origin);return drafts.bind(claim,result,tracker,{reconciliation:true});},
  async checkout(owner,id){const row=await drafts.attempted(owner,id);await permit(row);return drafts.checkout(owner,id);},
  // The tracking worker only receives the GET-only reader. It cannot create a payment.
  createWorker(){const worker=createLiveWorker({store:{...tracker,apply:async(claim,result)=>{const applied=await tracker.apply(claim,result);if(applied)await drafts.closeVerified(claim.id);return applied;}},pay:reader});return {...worker,tick:async()=>{await drafts.recoverStalled();await worker.tick();}};},
  trackingHandler:options=>createLiveTrackingHandler({...options,store:tracker,origin,simulated:false}),
  acceptVerifiedEvent:event=>tracker.accept(event)
 });
}
