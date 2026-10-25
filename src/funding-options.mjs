import {fundingEntry} from './funding-entry.mjs';
const labels={revolut:'Revolut account balance',wise:'Wise'};
// Presentation only. Server-side permissions and offer checks remain authoritative.
export function peerMethods(state){
 const rails=state?.liveFunding?.rails;
 return Array.isArray(rails)?[...new Set(rails)].filter(id=>Object.hasOwn(labels,id)).map(id=>({id,label:labels[id]})):[];
}
export function fundingOptions(state){
 const customer=!!state?.account,methods=peerMethods(state);
 const liveRequested=state?.liveFunding?.paymentsEnabled===true;
 const live=customer&&liveRequested&&state?.paymentsDisabled===false&&methods.length>0;
 const testing=customer&&!liveRequested&&state?.paymentsDisabled===true&&state?.previewMode===true;
 const peerTest=testing&&state?.fundingJourneyEnabled===true;
 const rampTest=testing&&state?.rampFunding?.mode==='simulation'&&state.rampFunding.paymentsEnabled===false&&state.rampFunding.externalConnectionsEnabled===false;
 const prepare=customer&&!liveRequested&&state?.liveFunding?.draftsEnabled===true;
 const entry=customer?fundingEntry(state):null;
 const action=entry?.existing?{kind:entry.kind,id:entry.id,label:'Review existing request'}:live||prepare?(!state.agents?.length?{kind:'wallet',label:'Add a receiving wallet',needsWallet:true}:{kind:'live-fund',label:live?'Continue with Peer':'Prepare a funding request'}):null;
 return {customer,methods,live,peerTest,rampTest,prepare,existing:!!entry?.existing,action};
}
