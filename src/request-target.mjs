import {fundingCosts} from './funding-costs.mjs';
import {targetRaw,compareTarget} from '../shared/funding-request.mjs';
export function requestTargetEvidence(request,order,draft,now=Date.now()){
 if(!request||!draft||!order||request.draftId!==draft.id||order.id!==draft.id||request.agent.address.toLowerCase()!==draft.agent?.address?.toLowerCase()||order.agent?.address?.toLowerCase()!==request.agent.address.toLowerCase())return null;
 const pair=fundingCosts({verification:order.verification,requestedPence:draft.pence,currency:draft.currency,simulated:!!order.fixture||!!order.journey,review:!!order.reviewRequired,trackingError:!!order.trackingError,stopped:!!draft.stoppedAt,ended:['closed','cancelled'].includes(draft.status),now}).reviewPair;
 const amount=pair?targetRaw(pair.receive.split(' ')[0]):null,comparison=amount?compareTarget(request.targetRaw,amount):null;
 if(!comparison)return null;
 const d=order.delivery,arrived=pair.kind==='settled'&&pair.arrived&&order.status==='checkout_received'&&d?.finalized===true&&d.chainId===8453&&d.tokenAddress?.toLowerCase()==='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'&&d.recipient?.toLowerCase()===request.agent.address.toLowerCase()&&d.amountRaw===amount;
 return {pair,comparison,arrived};
}
