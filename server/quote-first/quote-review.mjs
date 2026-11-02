// Read-only contract compatibility and selected-term review. No wallet/SDK writes.
import {QuoteError} from './direct-quote.mjs';
// Verified against pinned @zkp2p/sdk 0.14.10 by an offline regression test.
export const pinnedOrchestrator='0x014025fde093f8701d86e9f38e2c3a9b779cb5c7';
export function quoteIntegration(orchestrator){
 return Object.freeze({contractRecognised:typeof orchestrator==='string'&&orchestrator.toLowerCase()===pinnedOrchestrator,executionVerified:false,canReserve:false});
}
export function reviewInput(input,validateTarget){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['amount','currency','method','offerId'].includes(k))||!/^([a-f0-9]{64})$/.test(input.offerId??'')||!input.method||input.method==='all')throw new QuoteError('invalid_selection');
 const {offerId,...target}=input;validateTarget(target);return {offerId,target};
}
export function compareSelectedQuote(offerId,response,{now=Date.now()}={}){
 if(!/^[a-f0-9]{64}$/.test(offerId)||response?.route!=='peer_direct'||response.canCreatePayment!==false||!Array.isArray(response.rows)||!Number.isSafeInteger(now)||!Number.isFinite(response.checkedAt)||response.checkedAt>now)throw new QuoteError('invalid_review');
 const all=response.rows.flatMap(r=>r.offers??[]),matched=all.find(q=>q.id===offerId);
 let status;
 if(matched)status=matched.validUntil>now?'terms_match':'refresh_required';
 else if(all.length)status='terms_changed';
 else status=response.rows.some(r=>['unavailable','evidence_incomplete'].includes(r.status))?'could_not_verify':'offer_unavailable';
 // Example-address comparisons can never establish a personalised payable offer.
 return {status,offer:status==='terms_match'?matched:null,rows:response.rows,checkedAt:response.checkedAt,eligibility:'example_addresses',route:'peer_direct',reserved:false,canCreatePayment:false,
  readiness:{buyer:'not_connected',destination:'not_selected',contract:matched?.integration?.contractRecognised===true?'execution_not_verified':'contract_not_verified',reservation:'disabled'}};
}
