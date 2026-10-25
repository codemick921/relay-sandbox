import FundingCosts from './FundingCosts';
import {inputPence} from './funding-costs.mjs';
import {activeFundingDraft} from './funding-entry.mjs';
import PhoneResume from './PhoneResume';
import {canContinueCheckout} from './payment-resume.mjs';
import React,{useState,useEffect} from 'react';
import {Button,Modal,Field,Check,Notice} from './ui';
import {api,gbp} from './api';
import FundingInstructions from './FundingInstructions';

export function LiveFunding({state,act,busy,error,onClose,open,selected,fundingPreset}){
 const live=state.liveFunding?.paymentsEnabled===true;
 const [agentId,setAgentId]=useState(selected??state.agents[0]?.id??''),[amount,setAmount]=useState(fundingPreset?.amount??'25'),[rail,setRail]=useState(fundingPreset?.rail??(live?'revolut':'wise')),[confirmed,setConfirmed]=useState(false),[requestId]=useState(()=>crypto.randomUUID());
 const agent=state.agents.find(a=>a.id===agentId),existing=activeFundingDraft(state);
 return <Modal title={live?'Fund your agent with GBP':'Prepare GBP funding'} onClose={busy?()=>{}:onClose}>
  <Notice>{live?'Choose your receiving wallet and payment app. You will review Peer’s current rate, fees and recipient before paying.':'Payments are disabled. Saving a draft sends nothing to Peer.'}</Notice>
  {fundingPreset&&<Notice>Previous amount filled in for convenience. This is a new request: review the current rate, fees and payment instructions before paying.</Notice>}
  {error&&<Notice error>{error}</Notice>}
  {existing?<><p>You have an existing funding request. Open it to continue paying, cancel a draft or stop an unpaid request before choosing another amount.</p><Button className="full" onClick={()=>open('funding-draft',existing.id)}>Review existing request</Button></>:<form onSubmit={async e=>{e.preventDefault();const s=await act('funding/drafts',{requestId,agentId,amount,rail,confirm:confirmed});if(s)open('funding-draft',s.selectedFundingDraftId);}}>
   <Field label="Agent to fund"><select required disabled={busy} value={agentId} onChange={e=>{setAgentId(e.target.value);setConfirmed(false);}}><option value="" disabled>Choose an agent</option>{state.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
   {!state.agents.length&&<Button type="button" secondary onClick={()=>open('wallet')}>Add agent wallet</Button>}
   {live&&<Field label="Pay GBP with"><select value={rail} disabled={busy} onChange={e=>{setRail(e.target.value);setConfirmed(false);}}><option value="revolut">Revolut account balance</option><option value="wise">Wise</option></select></Field>}
   <Field label="GBP funding amount" hint={rail==='revolut'?'£0.01–£1,000. Available offers and provider limits apply.':'£2–£1,000. Available offers and provider limits apply.'}><div className="money-input"><span>£</span><input aria-label="GBP funding amount" required disabled={busy} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={amount} onChange={e=>{setAmount(e.target.value);setConfirmed(false);}}/></div></Field>
   <p className="fine-print">Your wallet receives USDC on the Base network.</p><FundingCosts requestedPence={inputPence(amount)}/>
   {agent&&<><p>Receiving address</p><code className="checkout-address">{agent.address}</code></>}
   <Check checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}>This is my receiving wallet. I have checked the full address and amount.</Check>
   <Button className="full spaced" disabled={busy||!agent||!confirmed}>{busy?'Saving…':'Review funding request'}</Button>
  </form>}
 </Modal>;
}
export function FundingDraft({state,draft,act,busy,error,onClose,open}){
 const live=state.liveFunding?.paymentsEnabled===true;
 const [consent,setConsent]=useState(false),[link,setLink]=useState(null),[localError,setError]=useState(''),[opening,setOpening]=useState(false),[cancelOpen,setCancelOpen]=useState(false),[noPayment,setNoPayment]=useState(false);
 useEffect(()=>{setLink(null);setConsent(false);setError('');setCancelOpen(false);setNoPayment(false);},[draft?.id,draft?.status,draft?.cancellationState,draft?.stoppedAt,state.orders.find(o=>o.id===draft?.id)?.status,state.orders.find(o=>o.id===draft?.id)?.trackingError,state.orders.find(o=>o.id===draft?.id)?.reviewRequired]);
 if(!draft)return <Modal title="Funding request" onClose={onClose}><Notice>This request is no longer available in your account.</Notice></Modal>;
 const draftOnly=draft.status==='draft',cancelled=draft.status==='cancelled',bound=draft.status==='bound',closed=draft.status==='closed';
 const tracked=state.orders.find(o=>o.id===draft.id),ready=canContinueCheckout(draft,tracked,live);
 async function resume(){setOpening(true);setError('');try{const r=await api('funding/resume',{id:draft.id,confirm:true});setLink(r.checkoutUrl);}catch(e){setError(e.message);}finally{setOpening(false);}}
 return <Modal title="Your GBP funding request" onClose={busy?()=>{}:onClose}>
  {state.account&&<button className="text-button" onClick={()=>open('payment-help',draft.id)}>Payment help and downloadable record</button>}
  <Notice>{draft.stoppedAt?'Stopped in Relay. You can start a new funding request. The old Peer checkout may still be open; do not pay it.':cancelled?(draft.cancellationState==='confirmed'?'Peer has confirmed cancellation. You can create a new request with a different amount.':'Draft cancelled. No checkout was created.'):draftOnly?'Saved in Relay. No checkout has been created yet.':closed?'The funds arrived in your wallet. Open the receipt to see the confirmed transfer.':bound?(draft.cancellationState==='requested'?'Your cancellation request is saved. The order is not cancelled yet.':'Your Peer checkout is saved. Use this request to continue the same payment.'):'Relay has not confirmed whether Peer created this checkout. Keep this request while Relay checks; do not pay a replacement.'}</Notice>
  {!draft.stoppedAt&&draft.cancellationState==='requested'&&<Notice>Your earlier cancellation request is awaiting review. If you have not paid, you can stop the request in Relay and start again below.</Notice>}
  {!draft.stoppedAt&&draft.cancellationState==='blocked'&&<Notice error>Peer cancellation is unavailable. If you have not paid, Relay can check whether you can stop this request and start again.</Notice>}
  {(error||localError)&&<Notice error>{error||localError}</Notice>}
  <dl className="details"><div><dt>Requested funding</dt><dd>{gbp(draft.pence)}</dd></div><div><dt>Pay with</dt><dd>{draft.rail==='revolut'?'Revolut':'Wise'} · GBP</dd></div><div><dt>Agent</dt><dd>{draft.agent.name}</dd></div><div><dt>Receives</dt><dd>USDC on Base</dd></div></dl>
  <FundingCosts requestedPence={draft.pence} verification={tracked?.verification} simulated={!!tracked?.fixture||!!tracked?.journey} stopped={!!draft.stoppedAt} ended={cancelled||closed} review={!!tracked?.reviewRequired||tracked?.status==='checkout_review'} trackingError={!!tracked?.trackingError}/>
  <p>Receiving address</p><code className="checkout-address">{draft.agent.address}</code>
  {!draft.walletCurrent&&draftOnly&&<Notice error>The saved wallet has changed. Cancel this draft and review the updated address.</Notice>}
  {!draft.supersededBy&&<FundingInstructions preview={!live||draftOnly} rail={draft.rail} requestedPence={draft.pence} stage={draft.stoppedAt?'stopped':closed||cancelled?'closed':draftOnly?'ready':tracked?.status==='checkout_partial'?'partial':ready?'ready':'tracking'}/>}
  <PhoneResume key={draft.id} id={draft.id} trackingOnly={!!draft.stoppedAt||closed||cancelled||(!draftOnly&&!ready)}/>
  {live&&ready&&<Notice>Already paid or scheduled it? Open the same checkout only to complete verification. Do not send another transfer.</Notice>}
  {draft.stoppedAt?null:draft.supersededBy?<Button onClick={()=>open('funding-draft',draft.supersededBy)}>Open replacement request</Button>:live&&draftOnly?<>
   <Check checked={consent} onChange={e=>setConsent(e.target.checked)}>Create a real Peer checkout and share this amount, receiving address and order reference with Peer. I will review the final payment details before paying.</Check>
   <Button className="full spaced" disabled={busy||!consent||!draft.walletCurrent} onClick={()=>act('funding/checkout',{id:draft.id,confirm:true,consent:true})}>{busy?'Creating checkout…':'Create real Peer checkout'}</Button>
  </>:live&&ready?<>
   <Button className="full spaced" disabled={opening} onClick={resume}>{opening?'Checking saved checkout…':'Continue existing Peer checkout'}</Button>
   {link&&<a className="button full spaced" href={link} target="_blank" rel="noopener noreferrer">Open Peer payment instructions ↗</a>}
  </>:!live&&!closed&&!cancelled&&<Button className="full" disabled>Payments disabled</Button>}
  {(bound||closed||draft.cancellationState==='confirmed')&&<Button secondary className="full spaced" onClick={()=>open('order',draft.id)}>Track payment and wallet delivery</Button>}
  {draftOnly&&<Button secondary className="full spaced" disabled={busy} onClick={async()=>{if(await act('funding/cancel',{id:draft.id}))open('live-fund',draft.agent.id);}}>Cancel draft and choose another amount</Button>}
  {(cancelled||draft.stoppedAt)&&<Button className="full spaced" onClick={()=>open('live-fund',draft.agent.id)}>Create a new funding request</Button>}
  {bound&&!draft.supersededBy&&!draft.stoppedAt&&<>
   <Button secondary className="full spaced" disabled={busy} onClick={()=>setCancelOpen(!cancelOpen)}>Stop this request and start again</Button>
   {cancelOpen&&<section className="checkout-setup"><h3>Choose a new amount</h3><p>This stops the request in Relay and lets you start a new one immediately. It does not cancel the Peer checkout, cancel a bank transfer or refund money. Do not use the old payment link or instructions.</p><p>If you have already sent or scheduled payment, keep tracking this order instead. Relay will continue checking the old order for any late funds.</p>
    <Check checked={noPayment} onChange={e=>setNoPayment(e.target.checked)}>I have not sent or scheduled any payment for this order, and I will not pay its old checkout.</Check>
    <Button className="full spaced" disabled={busy||!live||!noPayment} onClick={async()=>{if(await act('funding/stop',{id:draft.id,confirmNoPayment:true}))open('live-fund',draft.agent.id);}}>{busy?'Checking payment status…':'Stop request and choose a new amount'}</Button>
   </section>}
  </>}
  <p className="fine-print">Peer may require identity or payment verification. Do not pay an unrecognised recipient, an expired offer or a different amount. A checkout or return to Relay does not confirm wallet delivery.</p>
  <p className="fine-print">Reference: {draft.id}</p>
 </Modal>;
}
