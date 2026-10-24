import React,{useState} from 'react';
import {Modal,Notice,Button,Field,Check} from './ui';
import {gbp} from './api';
export function FundingOptions({state,open,onClose,selected}){
 return <Modal title="Choose how to fund your agent" onClose={onClose}>
  <h3>Peer Pay</h3><p>{state.liveFunding?.paymentsEnabled?'Pay GBP through Revolut or Wise. Review the current offer and payment instructions in Peer.':'Try the simulated Peer funding journey.'}</p><Button className="full" onClick={()=>open('peer-fund',selected)}>{state.liveFunding?.paymentsEnabled?'Continue with Peer':'Test Peer funding'}</Button>
  <h3 className="spaced">Ramp Network · test preview</h3><p>Try a simulated GBP bank-payment journey into USDC on Base. Ramp is not connected yet; this preview sends nothing to Ramp.</p><Button secondary className="full" onClick={()=>open('ramp-fund',selected)}>Try Ramp preview</Button>
 </Modal>;
}
export function RampFunding({state,act,busy,error,open,onClose,selected}){
 const [agentId,setAgentId]=useState(selected??state.agents[0]?.id??''),[amount,setAmount]=useState('25'),[confirmed,setConfirmed]=useState(false),[requestId]=useState(()=>crypto.randomUUID());
 const agent=state.agents.find(a=>a.id===agentId);
 return <Modal title="Ramp funding preview" onClose={onClose}><Notice>Simulation only. No Ramp account connection, bank payment or real wallet transfer.</Notice>{error&&<Notice error>{error}</Notice>}<form onSubmit={async e=>{e.preventDefault();const s=await act('ramp-test/create',{requestId,agentId,amount,confirm:confirmed});if(s)open('order',s.selectedOrderId);}}>
  <Field label="Receiving agent"><select value={agentId} onChange={e=>{setAgentId(e.target.value);setConfirmed(false);}}><option value="" disabled>Choose a saved wallet</option>{state.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
  {!agent&&<Button type="button" secondary onClick={()=>open('wallet')}>Add agent wallet</Button>}
  <Field label="Example GBP amount" hint="£2–£1,000 for this preview. These are not Ramp’s live limits."><input required value={amount} inputMode="decimal" onChange={e=>{setAmount(e.target.value);setConfirmed(false);}}/></Field>
  {agent&&<code className="checkout-address">{agent.address}</code>}
  <p>The planned live journey would open Ramp’s checkout for its eligibility checks, current quote and bank-payment instructions. Your saved wallet will be the proposed receiving address.</p>
  <Check checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}>Create a simulated order. No money will move.</Check><Button className="full spaced" disabled={busy||!agent||!confirmed}>Start Ramp simulation</Button>
 </form></Modal>;
}
export function RampOrder({order,act,busy,error,onClose}){
 const names=['Waiting for example bank payment','Example bank payment confirmed','Example transfer found · waiting for finality','Simulated wallet receipt confirmed'];
 return <Modal title="Your Ramp test order" onClose={onClose}><Notice>Simulation · no real funds. The amounts, fees, payment status and wallet receipt below are generated test data, not a Ramp quote or transaction.</Notice>{error&&<Notice error>{error}</Notice>}<h3 aria-live="polite">{names[order.stage]}</h3>
  <dl className="details"><div><dt>Example total</dt><dd>{gbp(order.quote.pence)}</dd></div><div><dt>Example fee included</dt><dd>{gbp(order.feePence)}</dd></div><div><dt>Example net receipt</dt><dd>{(Number(order.cryptoAmount)/1e6).toFixed(6)} USDC · Base</dd></div></dl>
  <p>Receiving wallet · {order.agent.name}</p><code className="checkout-address">{order.agent.address}</code>
  <ol><li>Review the example amount, fee and saved wallet above.</li><li>Use the simulation buttons to advance the test. Do not send any money.</li><li>Check the generated receipt. Live Ramp checkout and bank instructions are not connected.</li></ol>
  {order.stage<3?<Button className="full" disabled={busy} onClick={()=>act('ramp-test/advance',{id:order.id,stage:order.stage})}>{['Simulate bank payment','Simulate USDC transfer','Simulate finalised wallet receipt'][order.stage]}</Button>:<div className="receipt"><h3>Simulation complete</h3><p>The receipt checker matched the token, amount, receiving address and finalised block using generated evidence. This does not prove live Ramp delivery.</p></div>}
  <p className="fine-print">Saved test reference: {order.id}</p>
 </Modal>;
}
