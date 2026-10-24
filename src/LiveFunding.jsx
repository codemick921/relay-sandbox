import React,{useState} from 'react';
import {Button,Modal,Field,Check,Notice} from './ui';
import {gbp} from './api';

export function LiveFunding({state,act,busy,error,onClose,open,selected}){
 const [agentId,setAgentId]=useState(selected??state.agents[0]?.id??''),[amount,setAmount]=useState('25'),[confirmed,setConfirmed]=useState(false),[requestId]=useState(()=>crypto.randomUUID());
 const agent=state.agents.find(a=>a.id===agentId),existing=state.fundingDrafts?.find(d=>!['cancelled','closed'].includes(d.status));
 return <Modal title="Prepare GBP funding" onClose={busy?()=>{}:onClose}>
  <Notice>Real payments are disabled. You can save a funding draft in Relay; this sends nothing to Peer or Wise.</Notice>
  {error&&<Notice error>{error}</Notice>}
  {existing?<><p>You have a saved funding draft. Review it before preparing another.</p><Button className="full" onClick={()=>open('funding-draft',existing.id)}>Review saved draft</Button></>:<form onSubmit={async e=>{e.preventDefault();const s=await act('funding/drafts',{requestId,agentId,amount,confirm:confirmed});if(s)open('funding-draft',s.selectedFundingDraftId);}}>
   <Field label="Agent to fund"><select required disabled={busy} value={agentId} onChange={e=>{setAgentId(e.target.value);setConfirmed(false);}}><option value="" disabled>Choose an agent</option>{state.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
   {!state.agents.length&&<Button type="button" secondary onClick={()=>open('wallet')}>Add agent wallet</Button>}
   <Field label="GBP funding amount" hint="Choose £2 to £1,000. Rates and fees have not been quoted."><div className="money-input"><span>£</span><input aria-label="GBP funding amount" required disabled={busy} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={amount} onChange={e=>{setAmount(e.target.value);setConfirmed(false);}}/></div></Field>
   <dl className="details"><div><dt>Payment route</dt><dd>GBP through Wise</dd></div><div><dt>Destination</dt><dd>USDC on Base</dd></div><div><dt>Expected receipt</dt><dd>Not quoted yet</dd></div></dl>
   {agent&&<><p>Receiving address</p><code className="checkout-address">{agent.address}</code></>}
   <p className="fine-print">Check the full address. Saving it does not verify that you control the wallet. You will need to review the current rate, fees and payment instructions before any payment.</p>
   <Check checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}>I have checked this amount and receiving address. Save this draft in Relay.</Check>
   <Button className="full spaced" disabled={busy||!agent||!confirmed}>{busy?'Saving draft…':'Save funding draft'}</Button>
  </form>}
 </Modal>;
}
export function FundingDraft({draft,act,busy,error,onClose,open}){
 if(!draft)return <Modal title="Funding draft" onClose={onClose}><Notice>This draft is no longer available in your account.</Notice></Modal>;
 const draftOnly=draft.status==='draft',cancelled=draft.status==='cancelled';
 return <Modal title="Your GBP funding draft" onClose={busy?()=>{}:onClose}>
  <Notice>{cancelled?'Draft cancelled. No payment was created.':draftOnly?'Saved in Relay. No payment has been created or sent to Peer.':'This request needs reconciliation. Do not start a replacement payment.'}</Notice>
  {error&&<Notice error>{error}</Notice>}
  <dl className="details"><div><dt>Funding amount</dt><dd>{gbp(draft.pence)}</dd></div><div><dt>Pay with</dt><dd>Wise · GBP</dd></div><div><dt>Agent</dt><dd>{draft.agent.name}</dd></div><div><dt>Receives</dt><dd>USDC on Base</dd></div><div><dt>Rate, fees and USDC amount</dt><dd>Not quoted</dd></div></dl>
  <p>Saved receiving address</p><code className="checkout-address">{draft.agent.address}</code>
  {!draft.walletCurrent&&!cancelled&&<Notice error>The saved wallet has changed. Cancel this draft and review the updated address before continuing.</Notice>}
  <h3>When live funding is enabled</h3>
  <ol className="setup-list"><li><span className="step-number">1</span><div><h3>Review Peer’s checkout</h3><p>Check the available Wise offer, rate, fees and receiving address.</p></div></li><li><span className="step-number">2</span><div><h3>Pay GBP through Wise</h3><p>Follow the checkout’s payment instructions and verification steps.</p></div></li><li><span className="step-number">3</span><div><h3>Track your wallet receipt</h3><p>Relay will confirm arrival only after matching the payment to a finalised USDC transfer on Base.</p></div></li></ol>
  <p className="fine-print">The intended route needs no buyer crypto wallet. Wise verification without an extension still needs to be verified in a controlled live test.</p>
  <Button className="full" disabled>Continue to Peer · payments disabled</Button>
  {draftOnly&&<Button secondary className="full spaced" disabled={busy} onClick={async()=>{const s=await act('funding/cancel',{id:draft.id});if(s)onClose();}}>Cancel draft</Button>}
  <button className="text-button spaced" disabled={busy} onClick={()=>open('fund',draft.agent.id)}>Try the simulated funding journey</button>
  <p className="fine-print">Draft reference: {draft.id}. Saving a draft does not reserve a rate or schedule a payment.</p>
 </Modal>;
}
