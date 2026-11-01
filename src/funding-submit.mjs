import {inputPence} from './funding-costs.mjs';
import {canContinueCheckout} from './payment-resume.mjs';
import {peerHandoffUrl} from './peer-handoff.mjs';

// Called only from the final, consented button. Never retry a checkout here.
// Keep the saved request available for recovery if any later step fails.
export async function submitFundingJourney({selection,agent,live,consent,act,resume,isCurrent=()=>true}){
 if(selection.confirm!==true||live&&!consent)return {error:'Review and confirm your funding details.'};
 const saved=await act('funding/drafts',selection);
 if(!saved||!isCurrent())return {};
 const id=saved.selectedFundingDraftId,draft=saved.fundingDrafts?.find(d=>d.id===id);
 const matches=draft&&draft.status==='draft'&&draft.walletCurrent===true&&!draft.stoppedAt&&!draft.trackingOnlyAt&&!draft.supersededBy&&draft.agent?.id===agent.id&&draft.agent.address?.toLowerCase()===agent.address?.toLowerCase()&&draft.agent.network==='Base'&&draft.agent.token==='USDC'&&draft.pence===inputPence(selection.amount)&&draft.currency===selection.currency&&draft.rail===selection.rail;
 if(!live||!matches||saved.paymentsDisabled===true||saved.liveFunding?.paymentsEnabled!==true)return {id};
 const created=await act('funding/checkout',{id,confirm:true,consent:true});
 if(!isCurrent())return {id};
 const bound=created?.fundingDrafts?.find(d=>d.id===id),order=created?.orders?.find(o=>o.id===id);
 if(!created||created.paymentsDisabled===true||!canContinueCheckout(bound,order,created.liveFunding?.paymentsEnabled===true))return {id};
 try{
  const result=await resume({id,confirm:true});
  return isCurrent()?{id,url:peerHandoffUrl(result,id)}:{id};
 }catch{return {id};}
}
