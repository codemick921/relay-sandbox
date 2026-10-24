import React,{useEffect,useRef,useState} from 'react';
import {Button,Modal,Notice,Check,Field} from './ui';
import {api,gbp,short,platformNames} from './api';
import {buildProof,matchingPayment,captureExpiry} from '../shared/payment.mjs';

export const liveLabels={ready_to_reserve:'Ready for wallet approval',reservation_unknown:'Reservation approval interrupted · check your wallet',reservation_pending:'Confirming the reservation',reservation_failed:'Reservation failed · do not pay',awaiting_payment:'Reserved · ready for your bank-app payment',release_unknown:'Release approval interrupted · check your wallet',release_pending:'Release submitted · checking delivery',release_failed:'Release transaction failed · check payment status',confirming:'USDC transfer found · awaiting finality',received:'USDC received · verified on Base',expired_unresolved:'Reservation expired · payment outcome unresolved',abandoned:'Unsubmitted order discarded'};
const active=['reservation_pending','awaiting_payment','release_unknown','release_pending','release_failed','confirming','expired_unresolved'];
export default function LiveOrder({order,act,onClose,busy,error}) {
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
  const [working,setWorking]=useState(false),[localError,setError]=useState(''),[info,setInfo]=useState(null),[confirmed,setConfirmed]=useState(false),[capture,setCapture]=useState(null),[rowIndex,setRowIndex]=useState(''),[prepared,setPrepared]=useState(null),[recovery,setRecovery]=useState(''),[note,setNote]=useState('');
  const subscription=useRef(null),mounted=useRef(true);
  useEffect(()=>()=>{mounted.current=false;subscription.current?.();},[]);
  useEffect(()=>{if(order.status!=='awaiting_payment'){subscription.current?.();subscription.current=null;setCapture(null);setPrepared(null);}},[order.status]);
  async function run(fn){setWorking(true);setError('');try{await fn();}catch(e){setError(e.message||'The action did not complete. Check the order before trying again.');}finally{if(mounted.current)setWorking(false);}}
  async function connection(){const w=await import('./peer-wallet.mjs');const account=await w.connectWallet();if(account.toLowerCase()!==order.quote.payer.toLowerCase())throw Error('Select the buying wallet shown on this order.');setInfo(await w.connectExtension());}
  async function submitReservation(){
    const w=await import('./peer-wallet.mjs');await w.walletFor(order.quote.payer);
    if((await w.extensionState()).state!=='ready')throw Error('Connect the Peer extension before reserving.');
    const s=await act('live-attempt',{id:order.id,phase:'reserve'});if(!s)return;
    try{const hash=await w.reserve(order);localStorage.setItem('relay-peer-tx:'+order.id+':reserve',hash);await act('live-submitted',{id:order.id,phase:'reserve',hash});}
    catch(e){if(w.wasRejected(e))await act('live-rejected',{id:order.id,phase:'reserve'});throw e;}
  }
  async function startCapture(){
    subscription.current?.();setCapture(null);setPrepared(null);setRowIndex('');
    const w=await import('./peer-wallet.mjs');
    subscription.current=await w.capture(order,message=>{if(mounted.current){setCapture(message);setNote('Select the matching payment below.');}},msg=>{if(mounted.current)setError(msg);});
    setNote('Complete payment-app verification in the tab opened by Peer, then return here.');
  }
  async function attest(){
    const row=capture?.metadata?.[Number(rowIndex)];
    if(rowIndex==='')throw Error('Select the exact payment first.');
    const proof=buildProof(capture,row,order);
    const w=await import('./peer-wallet.mjs');const result=await w.prepareRelease(order,proof);
    setPrepared(result);setCapture(null);subscription.current?.();subscription.current=null;
    setNote('Peer verified the payment and prepared its release. Approve the release in your buying wallet.');
  }
  async function submitRelease(){
    const w=await import('./peer-wallet.mjs');await w.walletFor(order.quote.payer);
    // Persist the attempt before entering the wallet, so reload cannot duplicate it.
    if(!await act('live-attempt',{id:order.id,phase:'release'}))return;
    try{const h=await w.release(order,prepared);localStorage.setItem('relay-peer-tx:'+order.id+':release',h);await act('live-submitted',{id:order.id,phase:'release',hash:h});}
    catch(e){if(w.wasRejected(e))await act('live-rejected',{id:order.id,phase:'release'});throw e;}
    finally{setPrepared(null);}
  }
  const pending=working||busy||order.fixture,expired=Date.parse(order.quote.expiresAt)<=now||Date.parse(order.tx.expiresAt)<=now,reservationExpired=order.expiresAt&&Date.parse(order.expiresAt)<=now;
  const unknown=['reservation_unknown','release_unknown'].includes(order.status),phase=order.status==='reservation_unknown'?'reserve':'release';
  return <Modal title="Fund your agent" onClose={working?()=>{}:onClose}>
    {order.fixture&&<Notice>Visual test fixture. No real reservation, payment or wallet receipt. Actions are disabled.</Notice>}
    <div className="native-progress"><span className={order.intentHash?'done':''}>1 · Reserve</span><span className={order.delivery?'done':''}>2 · Pay & verify</span><span className={order.status==='received'?'done':''}>3 · Receive</span></div>
    <h3 aria-live="polite">{liveLabels[order.status]||order.status}</h3>
    {(error||localError)&&<Notice error>{error||localError}</Notice>}
    <dl className="details"><div><dt>Payment</dt><dd>{gbp(order.quote.pence)} · {platformNames[order.quote.platform]}</dd></div><div><dt>Expected USDC</dt><dd>{order.quote.offers.find(o=>o.id===order.offerId)?.output} · Base</dd></div><div><dt>Provider fee</dt><dd>{order.quote.offers.find(o=>o.id===order.offerId)?.fee??'See reviewed quote'}</dd></div><div><dt>Agent</dt><dd>{order.agent.name}</dd></div></dl>
    <div className="destination-check"><p>Receiving wallet</p><code>{order.quote.recipient}</code><p className="fine-print">Buying wallet: {short(order.quote.payer)}</p></div>
    {order.status==='ready_to_reserve'&&<>
      <Notice>Two wallet approvals may be needed: reserve this offer, then release USDC after payment verification. Your wallet shows network fees. Relay never holds your GBP or wallet keys.</Notice>
      <Button secondary className="full spaced" disabled={pending} onClick={()=>run(connection)}>Connect buying wallet & Peer extension</Button>
      {info&&<p role="status">{info.state==='ready'?`Peer extension ready (${info.version}).`:'Install or update the Peer extension, then press Connect again.'}</p>}
      <Check checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}>I have checked the amount, Base destination and provider fee. I will review each wallet transaction and pay only after reservation is confirmed.</Check>
      <Button className="full spaced" disabled={pending||!confirmed||info?.state!=='ready'||expired} onClick={()=>run(submitReservation)}>{expired?'Offer expired':'Reserve offer in my wallet'}</Button>
      <Button secondary className="full spaced" disabled={pending} onClick={()=>act('live-abandon',{id:order.id})}>Discard unsubmitted order</Button>
    </>}
    {order.status==='awaiting_payment'&&order.payment&&!reservationExpired&&<>
      <section className="payment-instructions"><h3>Pay in {platformNames[order.quote.platform]}</h3><p>Send exactly <strong>{gbp(order.quote.pence)}</strong> to this Peer seller identifier:</p><code>{order.payment.recipient}</code><p className="fine-print">Check the recipient in your payment app. Do not guess bank details or send a second payment. Reservation ends {new Date(order.expiresAt).toLocaleString('en-GB')}.</p></section>
      <Button secondary className="full spaced" disabled={pending} onClick={()=>run(connection)}>Check wallet & verification extension</Button>
      <Button className="full spaced" disabled={pending||!!prepared} onClick={()=>run(startCapture)}>I have paid · verify in my payment app</Button>
      {note&&<p role="status">{note}</p>}
      {capture&&<section className="payment-rows"><h3>Select your payment</h3><p className="fine-print">Only an exact amount, currency and seller match can be selected. Peer also validates the payment against the reservation.</p>
        {capture.metadata.filter(r=>r.hidden===false).length===0&&<Notice>No visible payments were returned.</Notice>}
        {capture.metadata.map((row,i)=>row.hidden?null:<label key={i} className="payment-row"><input type="radio" name="payment-row" value={i} checked={rowIndex===String(i)} disabled={!matchingPayment(row,order)} onChange={()=>setRowIndex(String(i))}/><span>{String(row.amount??'Unknown amount')} {String(row.currency??'')} · {String(row.recipient??'Unknown recipient')}<small>{String(row.date??'')} {row.paymentId?` · ${String(row.paymentId)}`:''}{!matchingPayment(row,order)?' · Does not match this order':''}</small></span></label>)}
        <Button className="full spaced" disabled={pending||rowIndex===''||captureExpiry(capture)<=Date.now()} onClick={()=>run(attest)}>Verify selected payment with Peer</Button>
      </section>}
      {prepared&&<><Notice>Payment verified by Peer. The wallet transfer is not yet confirmed.</Notice><Button className="full spaced" disabled={pending} onClick={()=>run(submitRelease)}>Approve USDC release in my wallet</Button></>}
    </>}
    {unknown&&<><Notice>The wallet action may have been submitted. Check your wallet activity before continuing. Relay will not submit it again automatically.</Notice><Field label="Transaction hash from your buying wallet"><input value={recovery} placeholder="0x…" onChange={e=>setRecovery(e.target.value.trim())}/></Field><Button secondary disabled={pending} onClick={()=>run(async()=>{const h=recovery||localStorage.getItem('relay-peer-tx:'+order.id+':'+phase);if(!h)throw Error('No saved hash was found. Copy the transaction hash from your wallet.');await act('live-submitted',{id:order.id,phase,hash:h});})}>Recover transaction</Button></>}
    {order.status==='awaiting_payment'&&reservationExpired&&<Notice>The reservation deadline has passed. Do not send a payment. Check the order status; if you already paid, keep your receipt.</Notice>}
    {order.status==='expired_unresolved'&&<Notice>This timeout does not prove that your bank payment failed or was refunded. If you paid, keep your payment receipt and contact Peer support with this intent hash. Do not pay again.</Notice>}
    {order.status==='release_failed'&&<Notice>The bank payment may still have succeeded. Keep your receipt and contact Peer support with this intent hash; do not pay again.</Notice>}
    {order.status==='confirming'&&<Notice>The matching USDC transfer is on Base. Waiting for a finalised block before marking it received.</Notice>}
    {order.status==='received'&&<div className="receipt"><h3>{(Number(order.delivery.amountRaw)/1e6).toFixed(6)} USDC received</h3><p>Verified token, agent address, Peer intent and finalised Base transaction.</p><a href={`https://basescan.org/tx/${order.delivery.transactionHash}`} target="_blank" rel="noreferrer">View verified transfer ↗</a></div>}
    {active.includes(order.status)&&<Button secondary className="full spaced" disabled={pending} onClick={()=>act('live-refresh',{id:order.id})}>Check payment status</Button>}
    {order.intentHash&&<div className="destination-check"><p>Peer intent</p><code>{order.intentHash}</code></div>}
    {order.reservationTx&&<p><a href={`https://basescan.org/tx/${order.reservationTx}`} target="_blank" rel="noreferrer">Reservation transaction ↗</a></p>}
    <p className="fine-print">Keep this browser session to resume. Tracking refreshes while Relay is open. Bank-app sign-in and wallet approvals stay in their own secure windows.</p>
  </Modal>;
}
