import {paymentAttemptState} from '../shared/tracking-status.mjs';
const uuid=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// The fragment is only a reference. It never carries a session or provider token.
export function resumeLink(origin,id){
 if(typeof id!=='string'||!uuid.test(id))throw Error('Invalid request reference.');
 const url=new URL(origin);
 if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&url.hostname==='127.0.0.1')))throw Error('Use Eupova’s own secure address.');
 return `${url.origin}/#funding=${id}`;
}
export function resumeTarget(location){
 const hash=location.hash??'';
 if(hash.startsWith('#request=')){const id=hash.slice(9);return uuid.test(id)?{kind:'agent-request',id}:{kind:'invalid'};}
 if(hash.startsWith('#payment=')){
  const id=hash.slice('#payment='.length);return uuid.test(id)?{kind:'payment-help',id}:{kind:'invalid'};
 }
 if(hash.startsWith('#funding=')){
  const id=hash.slice('#funding='.length);return uuid.test(id)?{kind:'funding-draft',id}:{kind:'invalid'};
 }
 const query=new URLSearchParams(location.search??'');
 if(query.has('checkout')){const id=query.get('checkout');return uuid.test(id)?{kind:'order',id}:{kind:'invalid'};}
 return null;
}
export function resolveResume(target,state){
 if(!target)return null;
 if(target.kind==='agent-request'&&state.account&&state.agentFundingRequests?.some(r=>r.id===target.id))return target;
 // Payment detail reads are owner-authorised by the existing API, not this fragment.
 if(target.kind==='payment-help'&&state.account)return target;
 if(target.kind==='funding-draft'&&state.account&&state.fundingDrafts?.some(d=>d.id===target.id))return target;
 if(target.kind==='order'&&state.orders?.some(o=>o.id===target.id&&['checkout','ramp'].includes(o.kind)))return target;
 return {kind:'resume-unavailable'};
}
export function canContinueCheckout(draft,order,live){
 return !!(live&&draft?.status==='bound'&&!draft.stoppedAt&&!draft.trackingOnlyAt&&!draft.supersededBy&&draft.cancellationState!=='requested'&&order&&!paymentAttemptState(order)&&!order.reviewRequired&&!order.trackingError&&['checkout_ready','checkout_partial'].includes(order.status)&&(!order.chargebackStatus||order.chargebackStatus==='NONE'));
}
