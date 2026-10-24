import React,{useEffect,useState} from 'react';
import {Button,Modal,Field,Check,Notice,Icon} from './ui';
import {api,gbp} from './api';
import FundingInstructions from './FundingInstructions';

export const checkoutLabels={checkout_unknown:'Checkout needs recovery',checkout_ready:'Ready to open Peer checkout',checkout_recovery:'Checkout link needs recovery',checkout_partial:'Part payment received',sandbox_complete:'Sandbox complete · no real wallet receipt',checkout_cancelled:'Checkout cancelled',checkout_settled:'Payment verified · checking wallet',checkout_confirming:'USDC detected · awaiting finality',checkout_received:'Funds arrived in agent wallet',checkout_review:'Delivery needs review'};
export const testCheckoutLabels={checkout_ready:'Test checkout ready',checkout_partial:'Simulated part payment received',checkout_settled:'Test payment verified · checking simulated transfer',checkout_confirming:'Simulated USDC detected · awaiting test confirmation',checkout_received:'Simulated wallet delivery complete',checkout_cancelled:'Test checkout cancelled',checkout_review:'Test evidence needs review'};

export function PayInEvidence({evidence}){
 if(!evidence)return null;
 const labels={within_peer_limit:'Peer’s quoted amount is within the requested amount.',awaiting_selection:'No payment quote has been selected yet.',over_limit:'The payment amount exceeds the requested amount. Do not pay.',settled_observation:'Peer has recorded the GBP payment and settlement fee.',stale:'The saved quote needs a fresh check.',quote_expired:'The quote has expired. Do not pay.'};
 const money=raw=>`${(BigInt(raw)/1000000n).toString()}.${(BigInt(raw)%1000000n).toString().padStart(6,'0')}`;
 return <section className="panel spaced" aria-label="GBP funding amount and fees"><h3>GBP amount and fees</h3><p>{labels[evidence.status]??'Payment details need review. Do not pay.'}</p><dl className="details"><div><dt>{evidence.settlement?'GBP recorded by Peer':'Last observed Peer amount'}</dt><dd>{evidence.totalPence===null?'Not available':gbp(evidence.totalPence)}</dd></div>{evidence.settlement&&<><div><dt>Peer settlement fee</dt><dd>{money(evidence.settlement.feeUsdcRaw)} USDC</dd></div><div><dt>Net USDC reported by Peer</dt><dd>{money(evidence.settlement.netUsdcRaw)} USDC</dd></div></>}</dl><p className="fine-print">Peer fees reduce the USDC settlement. The fee shown excludes the seller’s exchange-rate spread. Separate payment-app fees are not visible to Relay. This observation does not authorise a payment.</p></section>;
}

export default function SimpleFunding({state,act,busy,error,onClose,open,selected}){
 const [agentId,setAgentId]=useState(selected??state.agents[0]?.id??''),[amount,setAmount]=useState('100'),[consent,setConsent]=useState(false),[setup,setSetup]=useState(null),[checking,setChecking]=useState(false),[requestId]=useState(()=>crypto.randomUUID());
 const agent=state.agents.find(a=>a.id===agentId);
 async function check(){setChecking(true);try{setSetup(await api('checkout-setup'));}catch{setSetup({ready:false,reason:'Connection check unavailable. Try again.'});}finally{setChecking(false);}}
 useEffect(()=>{check();},[]);
 return <Modal title="Fund your agent" onClose={busy?()=>{}:onClose}>
  <Notice>New checkout · sandbox only. No real payment or wallet delivery.</Notice>
  <div className="simple-intro"><span className="route-icon"><Icon name="bank"/></span><div><h3>Your payment app is enough</h3><p>Choose an agent, enter an amount, then continue to Peer Pay. No buying wallet to connect.</p></div></div>
  {error&&<Notice error>{error}</Notice>}
  <form onSubmit={async e=>{e.preventDefault();const s=await act('checkouts',{agentId,amount,requestId,consent,confirm:true});if(s){const order=s.orders.find(o=>o.requestId===requestId);if(order)open('order',order.id);}}}>
   <Field label="Agent to fund"><select required value={agentId} onChange={e=>setAgentId(e.target.value)}><option value="" disabled>Choose your agent</option>{state.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
   {!agent&&<button type="button" className="text-button" onClick={()=>open('wallet')}>Add your agent wallet</button>}
   <Field label="Funding amount" hint="GBP order value. Peer shows the final payment amount, rate and fees before you pay."><div className="money-input"><span>£</span><input aria-label="Funding amount" value={amount} onChange={e=>setAmount(e.target.value)} required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?"/></div></Field>
   <div className="quick-amounts">{['25','100','250'].map(a=><button type="button" key={a} className={amount===a?'selected':''} onClick={()=>setAmount(a)}>£{a}</button>)}</div>
   <dl className="details"><div><dt>Pay with</dt><dd>Wise · GBP</dd></div><div><dt>Agent receives</dt><dd>USDC on Base</dd></div><div><dt>Checkout</dt><dd>Peer Pay sandbox</dd></div></dl>
   {agent&&<details className="spaced"><summary>Receiving address</summary><code className="checkout-address">{agent.address}</code></details>}
   <p className="fine-print">Wise is the UK route we’re preparing for verification without an installation. Peer must confirm seller-only verification; its standard Pro flow can still ask for its app or extension.{!state.hostedSandbox&&' Revolut and Monzo remain in the existing flow.'}</p>
   <Check checked={consent} onChange={e=>setConsent(e.target.checked)}>Share this amount and my agent’s receiving address with Peer Pay for a sandbox checkout.</Check>
   <Button className="full spaced" disabled={busy||checking||!setup?.ready||!agent||!consent}>{busy?'Preparing checkout…':'Continue to Peer sandbox'}<Icon name="arrow" size={18}/></Button>
  </form>
  <section className="checkout-setup"><h3>{checking?'Checking connection…':setup?.ready?'Sandbox connected':'Merchant setup needed'}</h3><p>{setup?.reason??'Checking the server connection to Peer Pay.'}</p>{!setup?.ready&&<p className="fine-print">The operator needs a Peer Pay sandbox key. Live funding stays disabled while we confirm the verification route and destination delivery.</p>}<button className="text-button" disabled={checking} onClick={check}>Check connection again</button></section>
  {!state.hostedSandbox&&<div className="simple-alternatives"><button className="text-button" onClick={()=>open('practice')}>Try the existing practice journey</button><button className="text-button" onClick={()=>open('advanced',agentId)}>Advanced: browser wallet & extension</button></div>}
 </Modal>;
}

const usdc=raw=>{const n=BigInt(raw??'0');return `${n/1000000n}.${String(n%1000000n).padStart(6,'0').replace(/0+$/,'')||'00'}`;};
export function CheckoutOrder({order,act,busy,error,onClose,paymentsDisabled=false,children}){
 const [receiptView,setReceiptView]=useState(null),[receiptError,setReceiptError]=useState(''),[refreshMessage,setRefreshMessage]=useState('');
 useEffect(()=>{setReceiptView(null);setReceiptError('');},[order.id,order.status,order.trackingError]);
 async function showReceipt(){setReceiptError('');try{setReceiptView(await api(`${order.trackingPath??'live-tracking'}/orders/${order.id}/receipt`));}catch(e){setReceiptView(null);setReceiptError(e.message);}}
 const sandbox=order.source==='sandbox',v=order.verification,done=order.status==='checkout_received'&&!sandbox;
 const receipts=v?.payments?.filter(p=>p.receipt)??[],settled=v?.payments?.filter(p=>p.status==='SETTLED')??[];
 return <Modal title={order.journey?'Your test funding order':'Your Peer Pay checkout'} onClose={onClose}>
  {order.fixture?<Notice>Example tracking screen · simulated evidence only. No real funds moved.</Notice>:sandbox?<Notice>Sandbox order. Completion here does not prove a real payment or agent-wallet balance.</Notice>:<Notice>Relay checks Peer’s payment record and the USDC transfer to your saved Base address.</Notice>}
  {paymentsDisabled&&!order.tracking&&<Notice>Saved sandbox history. Peer connections are paused; this order cannot be opened or refreshed.</Notice>}
  {children}
  {error&&<Notice error>{error}</Notice>}
  {order.trackingError&&<Notice error>{order.trackingError} Last successful check: {order.checkedAt?new Date(order.checkedAt).toLocaleString('en-GB'):'not yet verified'}.</Notice>}
  <div className="transfer-summary" aria-live="polite"><span className="success-icon"><Icon name={done||order.status==='sandbox_complete'?'check':'clock'}/></span><div><h3>{gbp(order.quote.pence)} · {order.agent.name}</h3><p>{order.journey?'Test order · ':order.fixture?'Example · ':''}{order.checkoutEnded?(order.checkoutExpired?'Test checkout expired':'Test checkout cancelled'):(order.fixture?testCheckoutLabels:checkoutLabels)[order.status]??'Checking payment'}</p></div></div>
  {sandbox?<p>{order.status==='sandbox_complete'?'Peer confirmed this simulated order as fulfilled. No bank payment or on-chain delivery occurred.':'Complete the Wise simulation in Peer’s checkout, then return to check its status.'}</p>:<>
   <ol className="delivery-steps" aria-label="Funding progress">
    <li className={v?.providerFulfilled?'complete':''}><Icon name={v?.providerFulfilled?'check':'clock'}/><div><strong>{order.fixture?'Simulated · ':''}{v?.providerFulfilled?'Payment verified':settled.length?'Part payment verified':'Waiting for payment verification'}</strong><p>{order.fixture?'Simulated payment records for this preview.':'Confirmed from Peer’s current payment records.'}</p></div></li>
    <li className={receipts.length?'complete':''}><Icon name={receipts.length?'check':'clock'}/><div><strong>{order.fixture?'Simulated · ':''}{receipts.length?'USDC transfer detected':'Checking the wallet transfer'}</strong><p>Exact order, token, receiving address and net amount.</p></div></li>
    <li className={done?'complete':''}><Icon name={done?'check':'clock'}/><div><strong>{order.fixture?'Simulated · ':''}{done?'Funds arrived':BigInt(v?.receivedRaw??'0')>0n?'Part of the funds arrived':'Waiting for final confirmation'}</strong><p>{order.fixture?'This preview uses simulated Base blocks; no funds have moved.':done?'The transfer is recorded in a finalised Base block.':'Relay waits for Base to finalise each matching transfer.'}</p></div></li>
   </ol>
   {v&&<dl className="details"><div><dt>{order.fixture?'Simulated net settlement':'Net settled by Peer'}</dt><dd>{usdc(v.expectedNetRaw)} USDC</dd></div><div><dt>{order.fixture?'Simulated arrival':'Arrival confirmed'}</dt><dd>{usdc(v.receivedRaw)} USDC</dd></div></dl>}
   {order.status==='checkout_partial'&&<Notice>This order is partly funded. Any confirmed arrival is shown above; the full order is not complete.</Notice>}
   {order.status==='checkout_review'&&<Notice error>The settlement transaction needs review. Do not send another bank payment to resolve this status.</Notice>}
   {order.chargebackStatus&&order.chargebackStatus!=='NONE'&&<Notice error>Peer reports a payment chargeback. The historical wallet receipt remains recorded; the payment dispute needs separate review.</Notice>}
   {receipts.length>0&&<section className="delivery-receipts"><h3>{order.fixture?'Simulated wallet receipts':'Wallet receipts'}</h3>{receipts.map(p=><div key={p.id}><strong>{usdc(p.amountRaw)} USDC</strong><span>{order.fixture?'Simulated confirmation':p.receipt.finalized?'Finalised on Base':'Awaiting Base finality'}</span>{!order.fixture?<a href={`https://basescan.org/tx/${p.receipt.transactionHash}`} target="_blank" rel="noreferrer noopener">View transaction ↗</a>:<span>Illustrative receipt</span>}</div>)}</section>}
  </>}
  {!order.fixture&&!sandbox&&<PayInEvidence evidence={v?.payIn}/>}
  {(order.fixture||sandbox)&&!['sandbox_complete','checkout_received','checkout_cancelled'].includes(order.status)&&<FundingInstructions preview/>}
  {!order.fixture&&!sandbox&&!paymentsDisabled&&!order.checkoutEnded&&order.status==='checkout_ready'&&order.checkoutUrl&&<FundingInstructions/>}
  <dl className="details"><div><dt>Destination</dt><dd>USDC · Base</dd></div><div><dt>Verification</dt><dd>{order.fixture?'Simulated evidence only':sandbox?'Simulation only':done?'Finalised wallet receipt':'Independent receipt checks'}</dd></div></dl><code className="checkout-address">{order.agent.address}</code>
  {!paymentsDisabled&&!order.fixture&&order.checkoutUrl&&!['sandbox_complete','checkout_cancelled','checkout_received','checkout_confirming','checkout_settled','checkout_review'].includes(order.status)&&<a className="button full spaced" href={order.checkoutUrl} target="_blank" rel="noreferrer noopener">{sandbox?'Open Peer sandbox checkout':'Open Peer checkout'} ↗</a>}
  {order.status==='checkout_unknown'&&<><p>Keep this order while its creation is reconciled. Resume reuses the same request; it does not start a new purchase.</p><Button disabled={busy||order.fixture||paymentsDisabled} className="full spaced" onClick={()=>act('checkout-resume',{id:order.id})}>Recover this checkout</Button></>}
  {order.status==='checkout_recovery'&&<Notice>Peer returned the original order but could not recover its private checkout link. Reconcile it in the merchant dashboard before creating another order.</Notice>}
  {order.providerOrderId&&<><Button secondary disabled={busy||(order.fixture&&!order.tracking)||(paymentsDisabled&&!order.tracking)} className="full spaced" onClick={async()=>{setRefreshMessage('');if(await act(order.tracking?`${order.trackingPath??'live-tracking'}/orders/${order.id}/refresh`:'checkout-refresh',{id:order.id}))setRefreshMessage(order.tracking?'Check scheduled. This screen updates automatically.':'Status refreshed.');}}>{busy?'Scheduling check…':order.fixture?'Refresh simulated tracking':sandbox?'Check sandbox status':'Check payment and wallet'}</Button><p className="fine-print">{order.fixture?'Test order':'Peer order'}: {order.providerOrderId}<br/>{order.checkedAt?`Last checked ${new Date(order.checkedAt).toLocaleString('en-GB')}`:'Not checked yet'}</p></>}
  {refreshMessage&&<p role="status">{refreshMessage}</p>}
  {order.tracking&&done&&!order.reviewRequired&&<Button secondary className="full spaced" onClick={showReceipt}>{order.fixture?'View simulated receipt':'View verified receipt'}</Button>}
  {receiptError&&<Notice error>{receiptError}</Notice>}
  {receiptView&&receiptView.orderId===order.id&&Date.parse(receiptView.checkedAt)>=Date.parse(order.checkedAt??receiptView.checkedAt)&&done&&!order.reviewRequired&&<section className="panel spaced" aria-label="Wallet delivery receipt"><h3>{receiptView.simulated?'Simulated receipt · no real funds':'Verified wallet delivery'}</h3><dl className="details"><div><dt>{receiptView.simulated?'Simulated amount received':'Amount received'}</dt><dd>{usdc(receiptView.delivery.amountRaw)} USDC</dd></div><div><dt>Network</dt><dd>Base · {receiptView.delivery.chainId}</dd></div><div><dt>Last verified</dt><dd>{new Date(receiptView.checkedAt).toLocaleString('en-GB')}</dd></div></dl><p>Receiving address</p><code className="checkout-address">{receiptView.delivery.recipient}</code><p className="fine-print">Order: {receiptView.orderId}</p>{receiptView.trackingError&&<Notice error>{receiptView.trackingError}</Notice>}{receiptView.chargebackStatus&&receiptView.chargebackStatus!=='NONE'&&<Notice error>A payment dispute needs separate review.</Notice>}<p className="fine-print">{receiptView.simulated?'Illustrative evidence for testing only.':'This is evidence of a past transfer, not the current wallet balance or proof of wallet ownership.'}</p></section>}
  <p className="fine-print">{order.fixture?'Test evidence only. This does not confirm any real wallet balance or transfer.':sandbox?'A sandbox completion never becomes a real wallet receipt.':done?'This confirms the recorded arrival, not the wallet’s current spendable balance.':'Checking continues while the Relay server is running, even if you close this tab. A return link never confirms payment.'}</p>
 </Modal>;
}
