import DestinationGuide from './DestinationGuide';
import {RequestTarget} from './AgentFundingRequests';
import {requestState} from '../shared/funding-request.mjs';
import {peerHandoffUrl} from './peer-handoff.mjs';
import {useDialogState,DialogNavigation} from './DialogNavigation';
import {submitFundingJourney} from './funding-submit.mjs';
import {hasRecordedPayment} from '../shared/paid-request.mjs';
import FundingCompatibility,{fundingAssets} from './FundingCompatibility';
import {fundingCompatibility} from '../shared/funding-compatibility.mjs';
import {fundingCatalog,methodLabel,formatFiat,minimumMinor,supportsFunding} from '../shared/fiat.mjs';
import TrackingNotice from './TrackingNotice';
import {paymentAttemptState} from '../shared/tracking-status.mjs';
import FundingCosts from './FundingCosts';
import {peerMethods} from './funding-options.mjs';
import {inputPence} from './funding-costs.mjs';
import {fundingReviewAccess} from './funding-entry.mjs';
import PhoneResume from './PhoneResume';
import {canContinueCheckout} from './payment-resume.mjs';
import React,{useState,useEffect,useRef,useContext} from 'react';
import {Button,Modal,Field,Check,Notice,Icon} from './ui';
import {api,gbp} from './api';
import FundingInstructions from './FundingInstructions';
import './fund-wallet.css';

export function LiveFunding({state,act,busy,error,onClose,open,selected,fundingPreset}){
 const live=state.liveFunding?.paymentsEnabled===true;
 const methods=peerMethods(state);
 const [currency,setCurrency]=useDialogState('currency',fundingPreset?.currency??'GBP');
 const choices=fundingCatalog.methods.filter(m=>m.currencies.includes(currency));
 const available=choices.filter(m=>m.checkoutSupported&&(!live||methods.some(x=>x.id===m.id)));
 const [agentId,setAgentId]=useDialogState('agentId',selected??state.agents[0]?.id??''),[amount,setAmount]=useDialogState('amount',fundingPreset?.amount??'25'),[rail,setRail]=useDialogState('rail',live?(available.some(m=>m.id===fundingPreset?.rail)?fundingPreset.rail:available[0]?.id??''):'wise'),[confirmed,setConfirmed]=useState(false),[requestId]=useDialogState('requestId',()=>crypto.randomUUID());
 const [targetAsset,setTargetAsset]=useDialogState('targetAsset','base-usdc'),[route,setRoute]=useDialogState('route','merchant');
 const validMethod=available.some(m=>m.id===rail);
 const agent=state.agents.find(a=>a.id===agentId);
 const agentRequest=fundingPreset?.fundingRequestId?state.agentFundingRequests?.find(r=>r.id===fundingPreset.fundingRequestId):null;
 const {existing,reviewOnly,intercept}=fundingReviewAccess(state,agentRequest,agent);
 const requestOK=!fundingPreset?.fundingRequestId||!!agentRequest&&requestState(agentRequest,agent)==='open';
 const compatibility=fundingCompatibility({agent,rail,currency,amountMinor:inputPence(amount),targetAsset,route});
 const [step,setStep]=useDialogState('fundingStep',1),[consent,setConsent]=useState(false),[opening,setOpening]=useState(false);
 const navigation=useContext(DialogNavigation),heading=useRef(null),inFlight=useRef(false),mounted=useRef(true),latestState=useRef(state);
 latestState.current=state;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const locked=busy||opening;
 const walletOK=compatibility.checks.filter(c=>['wallet','asset'].includes(c.id)).every(c=>c.status==='pass')&&route==='merchant';
 const valid=requestOK&&walletOK&&compatibility.canSaveDraft&&validMethod;
 const changeStep=next=>{if(locked||inFlight.current)return;setStep(next);setConsent(false);setConfirmed(false);};
 useEffect(()=>{heading.current?.focus();heading.current?.closest('.modal')?.scrollTo({top:0});},[step]);
 // Any externally refreshed destination invalidates the user's acknowledgement.
 useEffect(()=>{setConsent(false);setConfirmed(false);},[agent?.address,agent?.network,agent?.token,live,state.paymentsDisabled]);
 const submit=async e=>{
  e.preventDefault();if(locked||inFlight.current||intercept)return;
  if(step===1){if(walletOK&&requestOK)changeStep(2);return;}
  if(step===2){if(valid)changeStep(3);return;}
  if(existing||!valid||!confirmed||live&&(!consent||state.paymentsDisabled===true))return;
  inFlight.current=true;setOpening(true);
  try{
   const result=await submitFundingJourney({selection:{requestId,agentId,amount,rail,currency,targetAsset,route,confirm:confirmed,...agentRequest?{fundingRequestId:agentRequest.id}:{}},agent,live,consent,act,resume:body=>api('funding/resume',body),isCurrent:()=>mounted.current});
   if(!mounted.current)return;
   if(result.url&&latestState.current.paymentsDisabled!==true&&canContinueCheckout(latestState.current.fundingDrafts?.find(d=>d.id===result.id),latestState.current.orders?.find(o=>o.id===result.id),latestState.current.liveFunding?.paymentsEnabled===true))window.location.assign(result.url);
   else if(result.id)open('funding-draft',result.id);
  }finally{inFlight.current=false;if(mounted.current)setOpening(false);}
 };
 const nav={...navigation,busy:locked,backLabel:step>1?'Back to '+(step===3?'amount and method':'choose wallet'):navigation?.backLabel??'Back',back:step>1?()=>changeStep(step-1):navigation?.back??onClose};
 return <DialogNavigation.Provider value={nav}><Modal title={live?'Fund a wallet':'Prepare funding'} className="fund-wallet-modal fund-wizard" wide onClose={locked?()=>{}:onClose}>
  {error&&<Notice error>{error}</Notice>}
  {intercept&&!opening?<section className="fund-existing"><span className="fund-screen-icon"><Icon name="clock"/></span><h3>Continue your saved request</h3><p>Your request is saved. Open it to check the payment status and next step.</p><Button className="full" onClick={()=>open('funding-draft',existing.id)}>Review existing request<Icon name="arrow" size={18}/></Button></section>:<>
  <ol className="fund-progress" aria-label="Funding steps">{['Choose wallet','Amount and method',reviewOnly?'Review details':'Review and pay'].map((label,i)=><li key={label} aria-current={step===i+1?'step':undefined} className={step>i+1?'is-complete':''}><span>{step>i+1?<Icon name="check" size={17}/>:i+1}</span><strong>{label}</strong></li>)}</ol>
  <div className="fund-screen-intro"><span className="fund-screen-icon"><Icon name={step===1?'wallet':step===2?'bank':'check'} size={26}/></span><div><p className="fund-step-count">Step {step} of 3</p><h3 ref={heading} tabIndex={-1}>{step===1?'Choose your receiving wallet.':step===2?'Choose how much to fund.':'Review your funding request.'}</h3><p>{step===1?'Use the receiving details from your agentic wallet.':step===2?'Choose your currency, payment method and amount.':reviewOnly?'Check your details. Your existing request stays unchanged.':live?'Check your details, then continue to Peer to review the offer and pay.':'Check your details before saving a draft. Payments are disabled.'}</p></div></div>
  {agentRequest&&<RequestTarget request={agentRequest}/>}
  {reviewOnly&&<Notice>Another funding request is still open. You can review these details without changing it. Your existing request keeps tracking.</Notice>}
  {!requestOK&&<Notice error>This funding request is no longer available to prepare. Return to Funding requests to review it.</Notice>}
  {fundingPreset&&!agentRequest&&<Notice>Previous amount filled in. Review the current offer before paying again.</Notice>}
  <form onSubmit={submit}>
   <div className="fund-form-grid">
    <div className="fund-form-fields">
     <fieldset disabled={locked||step!==1} hidden={step!==1} className="fund-form-section"><legend><Icon name="wallet" size={20}/>Receiving wallet</legend><p className="fund-section-help">Use the receiving details supplied by your agentic wallet.</p>
      <Field label="Agentic wallet"><select aria-label="Agentic wallet" required={step===1} disabled={locked||!!agentRequest} value={agentId} onChange={e=>{setAgentId(e.target.value);setConfirmed(false);}}><option value="" disabled>Choose a saved wallet</option>{state.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      {!state.agents.length&&<Button type="button" secondary className="full" onClick={()=>open('wallet')}><Icon name="plus" size={18}/>Add agentic wallet</Button>}
      <Field label="What asset does your agent need?"><select aria-label="Asset your agent needs" value={targetAsset} disabled={locked} onChange={e=>{setTargetAsset(e.target.value);setConfirmed(false);}}>{fundingAssets.map(asset=><option key={asset.id} value={asset.id}>{asset.label}</option>)}</select></Field>
      <Field label="Funding route"><select aria-label="Funding route" value={route} disabled={locked} onChange={e=>{setRoute(e.target.value);setConfirmed(false);}}><option value="merchant">Peer merchant checkout</option><option value="p2p">Direct P2P · not connected here</option></select></Field>
      <DestinationGuide/>
     </fieldset>
     <fieldset disabled={locked||step!==2} hidden={step!==2} className="fund-form-section fund-form-section--payment"><legend><Icon name="bank" size={20}/>Your payment</legend>
      <div className="fund-payment-pair">
       <Field label="Payment currency"><select aria-label="Payment currency" value={currency} disabled={locked} onChange={e=>{const c=e.target.value;setCurrency(c);setConfirmed(false);if(!supportsFunding(rail,c))setRail(fundingCatalog.methods.find(m=>m.checkoutSupported&&m.currencies.includes(c)&&(!live||methods.some(x=>x.id===m.id)))?.id??'');}}>{fundingCatalog.currencies.map(c=><option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}</select></Field>
       <Field label="Pay with"><select aria-label="Pay with" value={rail} disabled={locked||!available.length} onChange={e=>{setRail(e.target.value);setConfirmed(false);}}>{!validMethod&&<option value="">Choose a payment method</option>}{choices.map(m=><option key={m.id} value={m.id} disabled={!available.some(a=>a.id===m.id)}>{m.label}{!m.checkoutSupported?' · Not connected to checkout':!available.some(a=>a.id===m.id)?' · Unavailable':''}</option>)}</select></Field>
      </div>
      {!available.length&&<Notice>No connected checkout method supports this currency yet. Choose another currency. No payment request will be created.</Notice>}
      <Field label="Funding amount" hint={`${(minimumMinor(rail,currency)/100).toFixed(2)} to 1,000 ${currency} per request. Peer offers and limits also apply.`}><div className="money-input"><span>{currency}</span><input aria-label="Funding amount" required={step===2} disabled={locked||!available.length} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={amount} onChange={e=>{setAmount(e.target.value);setConfirmed(false);}}/></div></Field>
      <p className="fine-print">Peer checks availability when you open checkout. The method may need identity, phone or extension verification. Review those steps before paying.</p>
     </fieldset>
     {step===3&&<section className="fund-form-section fund-final-review"><div className="fund-review-title"><h3>Your payment details</h3><Button type="button" secondary disabled={locked} onClick={()=>changeStep(2)}>Edit</Button></div><dl className="fund-review-facts"><div><dt>Requested funding</dt><dd>{formatFiat(inputPence(amount),currency)}</dd></div><div><dt>Pay with</dt><dd>{methodLabel(rail)}</dd></div><div><dt>Funding route</dt><dd>Peer merchant checkout</dd></div></dl><p className="fine-print">The selected offer’s rate, fee and USDC estimate will appear in Peer. Check them before paying. Your bank or payment app may charge separately.</p><details className="fund-check-details"><summary>What happens after I continue?</summary><p>Peer shows the payment instructions and any verification steps. Return to Eupova to track the same request in Payments. Payment confirmation and wallet arrival are checked separately.</p></details></section>}
     {((step===1&&!walletOK)||(step>1&&!valid))&&<Notice error>{step===1?compatibility.checks.find(c=>['wallet','asset'].includes(c.id)&&c.status!=='pass')?.detail??'Choose Peer merchant checkout to continue.':'Check your wallet, currency, method and amount before continuing.'}</Notice>}
     {step===3&&<details className="fund-check-details fund-check-panel"><summary>Route checks and receiving asset</summary><FundingCompatibility requestSummary agent={agent} rail={rail} currency={currency} amountMinor={inputPence(amount)} targetAsset={targetAsset} route={route}/></details>}
    </div>
    <aside className="fund-review-panel" aria-label="Funding summary">
     <section className="fund-destination"><div className="fund-destination-title"><span className="fund-screen-icon"><Icon name="wallet" size={22}/></span><div><span>Receiving wallet</span><h3>{agent?.name??'Choose a wallet'}</h3></div>{step>1&&<Button type="button" secondary disabled={locked} onClick={()=>changeStep(1)}>Edit wallet</Button>}</div><span className="fund-network-label">USDC on Base</span>{agent?<><p>Check the full receiving address</p><code className="checkout-address">{agent.address}</code><small>Confirm your receiving platform accepts USDC on Base. Saving an address does not verify ownership or wallet support.</small></>:<p>Select the saved agentic wallet that should receive the funds.</p>}</section>
     {step===2&&<FundingCosts setupOnly requestedPence={inputPence(amount)} currency={currency}/>}
    </aside>
   </div>
   {step===3&&reviewOnly&&<section className="fund-form-section fund-existing-review"><h3>Review before starting another payment</h3><p>Check your existing request in Payments before continuing. No new draft or checkout has been created.</p><Button type="button" secondary disabled={locked} onClick={()=>open('funding-draft',existing.id)}>Review existing request<Icon name="arrow" size={18}/></Button></section>}
   {step===3&&!reviewOnly&&<div className="fund-confirm"><Check checked={confirmed} disabled={locked} onChange={e=>setConfirmed(e.target.checked)}>This is my receiving wallet. I have checked the full address and amount.</Check>{live&&<Check checked={consent} disabled={locked} onChange={e=>setConsent(e.target.checked)}>Create a real Peer checkout and share this amount, receiving address and order reference with Peer. I will review the final payment details before paying.</Check>}</div>}
   <div className="fund-step-actions"><p>{step===3&&reviewOnly?'Review only · your existing request is unchanged.':step<3?'No funding draft or Peer checkout is created until the final step.':live?'You’ll continue in Peer to review the offer and pay.':'Saving this draft sends nothing to Peer.'}</p><Button type="submit" disabled={locked||(step===1?!walletOK||!requestOK:!valid)||(step===3&&(!!existing||!confirmed||live&&(!consent||state.paymentsDisabled===true)))}>{opening?(live?'Opening Peer…':'Saving…'):step===1?'Continue to amount':step===2?(reviewOnly?'Review details':'Review and pay'):reviewOnly?'Review existing request first':live?'Pay with Peer':'Save funding draft'}<Icon name="arrow" size={18}/></Button></div>
  </form></>}
 </Modal></DialogNavigation.Provider>;
}

export function FundingDraft({state,draft,act,busy,error,onClose,open}){
 const live=state.liveFunding?.paymentsEnabled===true;
 const handoffInFlight=useRef(false),active=useRef(null),currentCheckout=useRef(null);
 useEffect(()=>{active.current=draft?.id;return()=>{active.current=null;};},[draft?.id]);
 const [consent,setConsent]=useState(false),[link,setLink]=useState(null),[localError,setError]=useState(''),[opening,setOpening]=useState(false),[cancelOpen,setCancelOpen]=useState(false),[noPayment,setNoPayment]=useState(false),[separate,setSeparate]=useState(false);
 useEffect(()=>{setLink(null);setConsent(false);setError('');setCancelOpen(false);setNoPayment(false);setSeparate(false);},[draft?.id,draft?.status,draft?.cancellationState,draft?.stoppedAt,draft?.trackingOnlyAt,state.orders.find(o=>o.id===draft?.id)?.status,state.orders.find(o=>o.id===draft?.id)?.trackingError,state.orders.find(o=>o.id===draft?.id)?.reviewRequired]);
 if(!draft)return <Modal title="Funding request" onClose={onClose}><Notice>This request is no longer available in your account.</Notice></Modal>;
 const draftOnly=draft.status==='draft',cancelled=draft.status==='cancelled',bound=draft.status==='bound',closed=draft.status==='closed';
 const tracked=state.orders.find(o=>o.id===draft.id),ready=canContinueCheckout(draft,tracked,live);
 currentCheckout.current={id:draft.id,ready};
 async function resume(){setOpening(true);setError('');try{const r=await api('funding/resume',{id:draft.id,confirm:true});setLink(r.checkoutUrl);}catch(e){setError(e.message);}finally{setOpening(false);}}
 async function payWithPeer(){
  if(handoffInFlight.current||busy||!live||!consent||!draft.walletCurrent||!draftOnly)return;
  handoffInFlight.current=true;setOpening(true);setError('');
  try{
   const saved=await act('funding/checkout',{id:draft.id,confirm:true,consent:true});
   if(!saved||active.current!==draft.id)return;
   const savedDraft=saved.fundingDrafts?.find(d=>d.id===draft.id),savedOrder=saved.orders?.find(o=>o.id===draft.id);
   if(!canContinueCheckout(savedDraft,savedOrder,saved.liveFunding?.paymentsEnabled===true))return;
   const result=await api('funding/resume',{id:draft.id,confirm:true});
   const destination=peerHandoffUrl(result,draft.id);
   if(active.current===draft.id&&currentCheckout.current?.id===draft.id&&currentCheckout.current.ready)window.location.assign(destination);
  }catch(e){if(active.current===draft.id)setError(e.message);}
  finally{handoffInFlight.current=false;if(active.current===draft.id)setOpening(false);}
 }
 return <Modal title="Your funding request" className="fund-request-modal" onClose={busy?()=>{}:onClose}>
  {state.account&&<button className="text-button" onClick={()=>open('payment-help',draft.id)}>Payment help and downloadable record</button>}
  <Notice>{draft.trackingOnlyAt&&!closed&&!cancelled?'This paid request is still tracking. Follow its progress in Activity while you fund another wallet or amount.':draft.stoppedAt?'Stopped in Eupova. You can start a new funding request. The old Peer checkout may still be open; do not pay it.':cancelled?(draft.cancellationState==='confirmed'?'Peer has confirmed cancellation. You can create a new request with a different amount.':'Draft cancelled. No checkout was created.'):draftOnly?'Saved in Eupova. No checkout has been created yet.':closed?'The funds arrived in your wallet. Open the receipt to see the confirmed transfer.':bound?(draft.cancellationState==='requested'?'Your cancellation request is saved. The order is not cancelled yet.':paymentAttemptState(tracked)?'Your funding request is saved. Review its status below.':'Your Peer checkout is saved. Use this request to continue the same payment.'):'Eupova has not confirmed whether Peer created this checkout. Keep this request while Eupova checks; do not pay a replacement.'}</Notice>
  {tracked&&<TrackingNotice order={tracked}/>}
  {!draft.stoppedAt&&!draft.trackingOnlyAt&&!hasRecordedPayment(tracked)&&draft.cancellationState==='requested'&&<Notice>Your earlier cancellation request is awaiting review. If you have not paid, you can stop the request in Eupova and start again below.</Notice>}
  {!draft.stoppedAt&&!draft.trackingOnlyAt&&!hasRecordedPayment(tracked)&&draft.cancellationState==='blocked'&&<Notice error>Peer cancellation is unavailable. If you have not paid, Eupova can check whether you can stop this request and start again.</Notice>}
  {(error||localError)&&<Notice error>{error||localError}</Notice>}
  <dl className="details"><div><dt>Requested funding</dt><dd>{formatFiat(draft.pence,draft.currency)}</dd></div><div><dt>Pay with</dt><dd>{methodLabel(draft.rail)} · {draft.currency??'GBP'}</dd></div><div><dt>Agent</dt><dd>{draft.agent.name}</dd></div><div><dt>Receives</dt><dd>USDC on Base</dd></div></dl>
  {draftOnly&&<FundingCompatibility requestSummary agent={draft.agent} rail={draft.rail} currency={draft.currency} amountMinor={draft.pence} walletCurrent={draft.walletCurrent}/>}
  <RequestTarget request={state.agentFundingRequests?.find(r=>r.draftId===draft.id)} order={tracked} draft={draft}/>
  <FundingCosts setupOnly={draftOnly&&!tracked&&!draft.stoppedAt} currency={draft.currency} expiry={paymentAttemptState(tracked)} reviewNoticeShown requestedPence={draft.pence} verification={tracked?.verification} simulated={!!tracked?.fixture||!!tracked?.journey} stopped={!!draft.stoppedAt} ended={cancelled||closed} review={!!tracked?.reviewRequired||tracked?.status==='checkout_review'} trackingError={!!tracked?.trackingError}/>
  <p>Receiving address</p><code className="checkout-address">{draft.agent.address}</code>
  {!draft.walletCurrent&&draftOnly&&<Notice error>The saved wallet has changed. Cancel this draft and review the updated address.</Notice>}
  {!draft.supersededBy&&<FundingInstructions currency={draft.currency} preview={!live||draftOnly} rail={draft.rail} requestedPence={draft.pence} stage={closed||cancelled?'closed':draft.trackingOnlyAt?'tracking':draft.stoppedAt?'stopped':draftOnly?'ready':tracked?.status==='checkout_partial'?'partial':ready?'ready':'tracking'}/>}
  <PhoneResume key={draft.id} id={draft.id} trackingOnly={!!draft.trackingOnlyAt||!!draft.stoppedAt||closed||cancelled||(!draftOnly&&!ready)}/>
  {live&&ready&&<Notice>Already paid or scheduled it? Open the same checkout only to complete verification. Do not send another transfer.</Notice>}
  {draft.stoppedAt||draft.trackingOnlyAt?null:draft.supersededBy?<Button onClick={()=>open('funding-draft',draft.supersededBy)}>Open replacement request</Button>:live&&draftOnly?<>
   <Check checked={consent} onChange={e=>setConsent(e.target.checked)}>Create a real Peer checkout and share this amount, receiving address and order reference with Peer. I will review the final payment details before paying.</Check>
   <Button className="full spaced" disabled={busy||opening||!consent||!draft.walletCurrent} onClick={payWithPeer}>{busy||opening?'Opening Peer…':'Pay with Peer'}</Button>
  </>:live&&ready?<>
   {!link&&<Button className="full spaced" disabled={opening||busy} onClick={resume}>{opening?'Checking saved checkout…':'Continue existing Peer checkout'}</Button>}
   {link&&<a className="button full spaced" href={link} target="_blank" rel="noopener noreferrer">Pay with Peer</a>}
  </>:!live&&!closed&&!cancelled&&<Button className="full" disabled>Payments disabled</Button>}
  {(bound||closed||draft.cancellationState==='confirmed')&&<Button secondary className="full spaced" onClick={()=>open('order',draft.id)}>Track payment and wallet delivery</Button>}
  {draftOnly&&<Button secondary className="full spaced" disabled={busy} onClick={async()=>{if(await act('funding/cancel',{id:draft.id}))open('live-fund',draft.agent.id);}}>Cancel draft and choose another amount</Button>}
  {(closed||cancelled||draft.stoppedAt||draft.trackingOnlyAt)&&<Button className="full spaced" onClick={()=>open('live-fund',draft.agent.id)}>Create a new funding request</Button>}
  {bound&&!draft.supersededBy&&!draft.stoppedAt&&!draft.trackingOnlyAt&&hasRecordedPayment(tracked)&&<section className="checkout-setup">
   <h3>Fund another amount</h3><p>Your payment is recorded. This request will keep tracking in Activity until its delivery is resolved. Starting a separate request does not cancel or refund it.</p>
   <Check checked={separate} disabled={busy} onChange={e=>setSeparate(e.target.checked)}>I want to add more funds. I am not paying again for this request.</Check>
   {error&&<Notice error>{error}</Notice>}
   <Button className="full spaced" disabled={busy||!separate} onClick={async()=>{if(await act('funding/track-separately',{id:draft.id,confirmSeparate:true}))open('live-fund',draft.agent.id);}}>{busy?'Opening new request…':'Start a new funding request'}</Button>
  </section>}
  {bound&&!draft.supersededBy&&!draft.stoppedAt&&!draft.trackingOnlyAt&&!tracked?.verification?.payments?.some(p=>p.status==='SETTLED')&&!tracked?.reviewRequired&&<>
   <Button secondary className="full spaced" disabled={busy} onClick={()=>setCancelOpen(!cancelOpen)}>Cancel this request and start again</Button>
   {cancelOpen&&<section className="checkout-setup"><h3>Choose a new amount</h3><p>This stops the request in Eupova and lets you start a new one immediately. It does not cancel the Peer checkout, cancel a bank transfer or refund money. Do not use the old payment link or instructions.</p><p>If you have already sent or scheduled payment, keep tracking this order instead. Eupova will continue checking the old order for any late funds.</p>
    {(error||localError)&&<Notice error>{error||localError}</Notice>}
    <Check checked={noPayment} onChange={e=>setNoPayment(e.target.checked)}>I have not sent or scheduled any payment for this order, and I will not pay its old checkout.</Check>
    <Button className="full spaced" disabled={busy||!live||!noPayment} onClick={async()=>{if(await act('funding/stop',{id:draft.id,confirmNoPayment:true}))open('live-fund',draft.agent.id);}}>{busy?'Checking payment status…':'Stop request and choose a new amount'}</Button>
   </section>}
  </>}
  <p className="fine-print">Peer may require identity or payment verification. Do not pay an unrecognised recipient, an expired offer or a different amount. A checkout or return to Eupova does not confirm wallet delivery.</p>
  <p className="fine-print">Reference: {draft.id}</p>
 </Modal>;
}
