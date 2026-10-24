// Dormant composition. Production observation never imports this or a POST writer.
import {createLiveFunding} from './live-funding.mjs';
import {InputError} from '../server/validation.mjs';
export function createRestrictedFunding({drafts,policy,writer,tracker,reader,merchantId,origin}){
 const authorise=async intent=>{const row=await drafts.review(intent.owner??(await tracker.query('SELECT owner FROM relay_funding_drafts WHERE id=$1',[intent.id])).rows[0]?.owner,intent.id);return policy.permit(row,merchantId);};
 const guardedDrafts={...drafts,claim:(owner,id,merchant)=>drafts.claim(owner,id,merchant,{guard:(c,row)=>policy.reserve(c,row,merchant)})};
 const flow=createLiveFunding({drafts:guardedDrafts,tracker,reader,writer:{reconcile:(...args)=>writer.reconcile(...args)},merchantId,origin,authorise});
 // The creation response has no selected payment quote. Peer cannot observe
 // charges made separately by Wise. Never release a checkout using a fabricated
 // all-fees flag, or consume the permanent attempt just to discover that gap.
 const disabled=async()=>{throw new InputError('Payments remain disabled. A controlled test needs separate approval and a final Wise debit review.',403);};
 return Object.freeze({...flow,start:disabled,checkout:disabled});
}
