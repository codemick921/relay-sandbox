import {requestState} from '../shared/funding-request.mjs';
// Presentation routing only. Every write remains behind the existing server checks.
export function activeFundingDraft(state) {
 return state.fundingDrafts?.find(d => !d.stoppedAt && !d.trackingOnlyAt && !d.supersededBy && !['cancelled','closed'].includes(d.status));
}
export function fundingEntry(state) {
 if (!state?.account) return null;
 if(state.testAccess?.revoked)return {kind:null,label:'Testing access revoked',disabled:true};
 if(state.testAccess?.mode==='simulation')return state.fundingJourneyEnabled?(state.agents?.length?{kind:'peer-fund',label:'Try test funding'}:{kind:'wallet',label:'Try test funding',needsWallet:true}):{kind:null,label:'Simulation unavailable',disabled:true};
 const draft = activeFundingDraft(state);
 if (draft) return {kind:'funding-draft',id:draft.id,label:'Review existing request',existing:true};
 const order = state.orders?.find(o => o.kind==='checkout' && o.source==='live' && !o.fixture && !o.journey && !o.stoppedInRelay && !o.trackingOnly && !['checkout_received','checkout_cancelled'].includes(o.status));
 if (order) return {kind:'order',id:order.id,label:'Review existing request',existing:true};
 const live = !!state.liveFunding?.paymentsEnabled;
 const test = !live && !!state.fundingJourneyEnabled;
 const available = live || test || !!state.liveFunding?.draftsEnabled;
 if (!available) return {kind:null,label:'Funding unavailable',disabled:true};
 const label = live ? 'Fund a wallet' : test ? 'Try test funding' : 'Prepare funding';
 if (!state.agents?.length) return {kind:'wallet',label,needsWallet:true};
 return {kind:live||test?'fund':'live-fund',label};
}

// Reviewing an agent request is navigation only. Existing drafts still block writes.
export function fundingReviewAccess(state,request,agent,now=Date.now()){
 const existing=activeFundingDraft(state);
 const reviewOnly=!!existing&&!!request&&requestState(request,agent,now)==='open';
 return {existing,reviewOnly,intercept:!!existing&&!reviewOnly};
}
