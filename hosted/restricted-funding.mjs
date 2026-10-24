// Dormant composition. Production observation never imports this or a POST writer.
import {createLiveFunding} from './live-funding.mjs';
import {InputError} from '../server/validation.mjs';
export function createRestrictedFunding({drafts,policy,writer,tracker,reader,merchantId,origin}){
 const authorise=async intent=>{const row=await drafts.review(intent.owner??(await tracker.query('SELECT owner FROM relay_funding_drafts WHERE id=$1',[intent.id])).rows[0]?.owner,intent.id);return policy.permit(row,merchantId);};
 const guardedDrafts={...drafts,claim:(owner,id,merchant)=>drafts.claim(owner,id,merchant,{guard:(c,row)=>policy.reserve(c,row,merchant)})};
 const guardedWriter={
  async create(intent,url){if(!await authorise(intent))throw new InputError('Test approval is unavailable.',403);const result=await writer.create(intent,url);
   // A GBP order value is not proof of the buyer's total debit. A future adapter
   // must supply independently validated exact pay-in evidence; missing data blocks the link.
   const payIn=result.payIn;
   if(payIn?.currency!=='GBP'||!Number.isSafeInteger(payIn.totalPence)||payIn.totalPence<200||payIn.totalPence>1000||payIn.totalPence>intent.quote.pence||payIn.includesAllFees!==true)throw new InputError('The total GBP pay-in could not be confirmed within the test limit. Do not pay.',409);
   return result;
  },
  reconcile:(...args)=>writer.reconcile(...args)
 };
 return createLiveFunding({drafts:guardedDrafts,tracker,reader,writer:guardedWriter,merchantId,origin,authorise});
}
