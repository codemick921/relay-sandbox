import React,{useState,useEffect} from 'react';
import {Button,Modal,Field,Check,Notice} from './ui';
import {api,gbp} from './api';
import FundingInstructions from './FundingInstructions';

export function LiveFunding({state,act,busy,error,onClose,open,selected}){
 const live=state.liveFunding?.paymentsEnabled===true;
 const [agentId,setAgentId]=useState(selected??state.agents[0]?.id??''),[amount,setAmount]=useState('25'),[rail,setRail]=useState(live?'revolut':'wise'),[confirmed,setConfirmed]=useState(false),[requestId]=useState(()=>crypto.randomUUID());
 const agent=state.agents.find(a=>a.id===agentId),existing=state.fundingDrafts?.find(d=>!d.supersededBy&&!['cancelled','closed'].includes(d.status));
 return <Modal title={live?'Fund your agent with GBP':'Prepare GBP funding'} onClose={busy?()=>{}:onClose}>
  <Notice>{live?'Choose your receiving wallet and payment app. You will review Peer’s current rate, fees and recipient before paying.':'Payments are disabled. Saving a draft sends nothing to Peer.'}</Notice>
  {error&&<Notice error>{error}</Notice>}
  {existing?<><p>You have an existing funding request. Open it to continue paying, cancel a draft or request cancellation before choosing another amount.</p><Button className="full" onClick={()=>open('funding-draft',existing.id)}>Review existing request</Button></>:<form onSubmit={async e=>{e.preventDefault();const s=await act('funding/drafts',{requestId,agentId,amount,rail,confirm:confirmed});if(s)open('funding-draft',s.selectedFundingDraftId);}}>
   <Field label="Agent to fund"><select required disabled={busy} value={agentId} onChange={e=>{setAgentId(e.target.value);setConfirmed(false);}}><option value="" disabled>Choose an agent</option>{state.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
   {!state.agents.length&&<Button type="button" secondary onClick={()=>open('wallet')}>Add agent wallet</Button>}
   {live&&<Field label="Pay GBP with"><select value={rail} disabled={busy} onChange={e=>{setRail(e.target.value);setConfirmed(false);}}><option value="revolut">Revolut account balance</option><option value="wise">Wise</option></select></Field>}
   <Field label="GBP funding amount" hint={rail==='revolut'?'£0.01–£1,000. Available offers and provider limits apply.':'£2–£1,000. Available offers and provider limits apply.'}><div className="money-input"><span>£</span><input aria-label="GBP funding amount" required disabled={busy} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={amount} onChange={e=>{setAmount(e.target.value);setConfirmed(false);}}/></div></Field>
   <dl className="details"><div><dt>Destination</dt><dd>USDC on Base</dd></div><div><dt>Rate, fees and USDC amount</dt><dd>Review in Peer checkout</dd></div></dl>
   {agent&&<><p>Receiving address</p><code className="checkout-address">{agent.address}</code></>}
   <Check checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}>This is my receiving wallet. I have checked the full address and amount.</Check>
   <Button className="full spaced" disabled={busy||!agent||!confirmed}>{busy?'Saving…':'Review funding request'}</Button>
  </form>}
 </Modal>;
}
export function FundingDraft({state,draft,act,busy,error,onClose,open}){
 const live=state.liveFunding?.paymentsEnabled===true;
 const [consent,setConsent]=useState(false),[link,setLink]=useState(null),[localError,setError]=useState(''),[opening,setOpening]=useState(false),[cancelOpen,setCancelOpen]=useState(false),[noPayment,setNoPayment]=useState(false);
 useEffect(()=>{setLink(null);setConsent(false);setError('');setCancelOpen(false);setNoPayment(false);},[draft?.id,draft?.status,draft?.cancellationState]);
 if(!draft)return <Modal title="Funding request" onClose={onClose}><Notice>This request is no longer available in your account.</Notice></Modal>;
 const draftOnly=draft.status==='draft',cancelled=draft.status==='cancelled',bound=draft.status==='bound',closed=draft.status==='closed';
 const tracked=state.orders.find(o=>o.id===draft.id),ready=bound&&draft.cancellationState!=='requested'&&tracked&&!tracked.reviewRequired&&!tracked.trackingError&&['checkout_ready','checkout_partial'].includes(tracked.status);
 async function resume(){setOpening(true);setError('');try{const r=await api('funding/resume',{id:draft.id,confirm:true});setLink(r.checkoutUrl);}catch(e){setError(e.message);}finally{setOpening(false);}}
 return <Modal title="Your GBP funding request" onClose={busy?()=>{}:onClose}>
  <Notice>{cancelled?(draft.cancellationState==='confirmed'?'Peer has confirmed cancellation. You can create a new request with a different amount.':'Draft cancelled. No checkout was created.'):draftOnly?'Saved in Relay. No checkout has been created yet.':closed?'Wallet delivery has been verified. Open the receipt to see the transfer.':bound?(draft.cancellationState==='requested'?'Your cancellation request is saved. The order is not cancelled yet.':'Your Peer checkout is saved. Continue the same order rather than creating another payment.'):'Creation is unresolved. Keep this request while it is reconciled; do not pay a replacement order.'}</Notice>
  {draft.cancellationState==='requested'&&<Notice>Your request is saved for manual merchant review. Do not pay or use its old checkout link. A new request will be available once Peer confirms cancellation.</Notice>}
  {draft.cancellationState==='blocked'&&<Notice error>Cancellation is unavailable because payment activity needs checking. Keep following this order’s tracking; do not pay a replacement.</Notice>}
  {(error||localError)&&<Notice error>{error||localError}</Notice>}
  <dl className="details"><div><dt>Requested funding</dt><dd>{gbp(draft.pence)}</dd></div><div><dt>Pay with</dt><dd>{draft.rail==='revolut'?'Revolut':'Wise'} · GBP</dd></div><div><dt>Agent</dt><dd>{draft.agent.name}</dd></div><div><dt>Receives</dt><dd>USDC on Base</dd></div></dl>
  <p>Receiving address</p><code className="checkout-address">{draft.agent.address}</code>
  {!draft.walletCurrent&&draftOnly&&<Notice error>The saved wallet has changed. Cancel this draft and review the updated address.</Notice>}
  {(draftOnly||ready)&&!draft.supersededBy&&<FundingInstructions preview={!live||draftOnly}/>}
  {draft.supersededBy?<Button onClick={()=>open('funding-draft',draft.supersededBy)}>Open replacement request</Button>:live&&draftOnly?<>
   <Check checked={consent} onChange={e=>setConsent(e.target.checked)}>Create a real Peer checkout and share this amount, receiving address and order reference with Peer. I will review the final payment details before paying.</Check>
   <Button className="full spaced" disabled={busy||!consent||!draft.walletCurrent} onClick={()=>act('funding/checkout',{id:draft.id,confirm:true,consent:true})}>{busy?'Creating checkout…':'Create real Peer checkout'}</Button>
  </>:live&&ready?<>
   <Button className="full spaced" disabled={opening} onClick={resume}>{opening?'Checking saved checkout…':'Continue existing Peer checkout'}</Button>
   {link&&<a className="button full spaced" href={link} target="_blank" rel="noopener noreferrer">Open Peer payment instructions ↗</a>}
  </>:!live&&!closed&&!cancelled&&<Button className="full" disabled>Payments disabled</Button>}
  {(bound||closed||draft.cancellationState==='confirmed')&&<Button secondary className="full spaced" onClick={()=>open('order',draft.id)}>Track payment and wallet delivery</Button>}
  {draftOnly&&<Button secondary className="full spaced" disabled={busy} onClick={async()=>{if(await act('funding/cancel',{id:draft.id}))open('live-fund',draft.agent.id);}}>Cancel draft and choose another amount</Button>}
  {cancelled&&<Button className="full spaced" onClick={()=>open('live-fund',draft.agent.id)}>Create a new funding request</Button>}
  {bound&&!draft.supersededBy&&draft.cancellationState!=='requested'&&<>
   <Button secondary className="full spaced" onClick={()=>setCancelOpen(!cancelOpen)}>Cancel or change amount</Button>
   {cancelOpen&&<section className="checkout-setup"><h3>Request cancellation</h3><p>The merchant must cancel this order in Peer. Peer only allows cancellation before any payment attempt has started, including attempts that later expire or fail.</p><p>Relay checks eligibility when you submit. This does not cancel a bank transfer or refund a payment. Once Peer confirms cancellation, you can choose a new amount.</p>
    <Check checked={noPayment} onChange={e=>setNoPayment(e.target.checked)}>I have not sent or scheduled any payment for this order.</Check>
    <Button className="full spaced" disabled={busy||!live||!noPayment} onClick={()=>act('funding/request-cancellation',{id:draft.id,confirmNoPayment:true})}>{busy?'Checking cancellation eligibility…':'Request cancellation'}</Button>
   </section>}
  </>}
  <p className="fine-print">Peer may require identity or payment verification. Do not pay an unrecognised recipient, an expired offer or a different amount. A checkout or return to Relay does not confirm wallet delivery.</p>
  <p className="fine-print">Reference: {draft.id}</p>
 </Modal>;
}
