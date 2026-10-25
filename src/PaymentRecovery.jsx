import TrackingNotice from './TrackingNotice';
import React,{useEffect,useState} from 'react';
import {api} from './api';
import {Button,Notice,Modal,Icon} from './ui';
import './payment-recovery.css';
const when=value=>value?new Date(value).toLocaleString('en-GB'):'Not available';
const value=(amount,unit)=>amount===null?'Not available':`${amount} ${unit}`;
export default function PaymentRecovery({state,open,onClose,selectedId}){
 const [records,setRecords]=useState([]),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[filter,setFilter]=useState('all'),[selected,setSelected]=useState(selectedId??null),[refresh,setRefresh]=useState(0);
 useEffect(()=>{let active=true;api(selectedId?'funding-history/'+encodeURIComponent(selectedId):'payment-records').then(data=>{if(active){setRecords(data.records);setLoaded(true);setError('');}}).catch(e=>{if(active){setError(e.message);setLoaded(true);}});return()=>{active=false;};},[state.orders,state.fundingDrafts,refresh,selectedId]);
 async function download(record,format){setBusy(true);setError('');try{
  const response=await fetch(`/api/payment-records/${encodeURIComponent(record.id)}/download?format=${format}`);
  if(!response.ok){const data=await response.json();if(response.status===401)window.dispatchEvent(new Event('relay-session-expired'));throw Error(data.error??'The download is unavailable.');}
  const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]??`relay-record.${format}`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(e){setError(e.message);}finally{setBusy(false);}}
 const record=records.find(r=>r.id===selected),shown=records.filter(r=>filter==='all'||filter==='attention'&&!['received','draft','ended'].includes(r.code)||filter==='received'&&r.deliveryConfirmed);
 const detail=r=><article className="recovery-detail" aria-label="Funding recovery details">
  <div className="recovery-heading"><span className="status-pill">{r.simulated?'Simulation · no real funds':'Live funding record'}</span><h3>{r.title}</h3><p>{r.agentName} · {value(r.requestedGbp,'GBP')} requested</p></div>
  <TrackingNotice tracking={r.tracking}/>
  {r.simulated&&<Notice>These are example payment and wallet records. They do not confirm real funds.</Notice>}
  <section className="recovery-next"><h4>What to do next</h4><p>{r.next}</p></section>
  {r.stopped&&r.code!=='stopped'&&<Notice>This request was stopped in Relay. Its Peer checkout was not cancelled by that action. Do not pay the old checkout; late transfers remain tracked.</Notice>}
  <dl className="details recovery-facts">
   <div><dt>Last successful check</dt><dd>{when(r.checkedAt)}</dd></div>
   <div><dt>Payment verification</dt><dd>{r.providerFulfilled?'Peer marked the payment complete':'Full payment not confirmed'}</dd></div>
   <div><dt>Wallet delivery</dt><dd>{r.deliveryConfirmed?'Funds arrived · confirmed on Base':r.confirmedUsdc!==null?'Some funds recorded · full arrival not yet confirmed':'Complete arrival not confirmed'}</dd></div>
   <div><dt>Payment recorded by Peer</dt><dd>{r.recordedFiat??'Not available'}</dd></div>
   <div><dt>USDC after Peer fees</dt><dd>{value(r.netUsdc,'USDC')}</dd></div>
   <div><dt>Arrival confirmed</dt><dd>{value(r.confirmedUsdc,'USDC')}</dd></div>
   <div><dt>Peer fees</dt><dd>{value(r.peerFeeUsdc,'USDC')}</dd></div>
   <div><dt>Receiving address</dt><dd><code>{r.address??'Not available'}</code><small>USDC on Base · saved for this request</small></dd></div>
   <div><dt>Relay request ID</dt><dd><code>{r.id}</code></dd></div>
   <div><dt>Peer order ID</dt><dd><code>{r.providerOrderId??'Not available'}</code></dd></div>
  </dl>
  <p className="fine-print">The requested GBP amount is not proof of the amount paid. The Peer fee shown here excludes bank or payment-app fees and any markup in the seller’s exchange rate.</p>
  {r.receipts.length>0&&<section><h4>{r.simulated?'Example transfers':'Confirmed wallet transfers'}</h4>{r.receipts.map(t=><div className="recovery-transfer" key={t.transactionHash}><strong>{t.amountUsdc} USDC</strong><code>{t.transactionHash}</code>{!r.simulated&&<a href={`https://basescan.org/tx/${t.transactionHash}`} target="_blank" rel="noreferrer">View transfer on Base ↗</a>}</div>)}</section>}
  <section className="recovery-download"><h4>{r.document==='receipt'?'Download wallet receipt':'Download status summary'}</h4><p>{r.document==='receipt'?'Keep a record of the confirmed delivery, destination and known fees.':'A full wallet receipt is not yet available. You can save the current status and request details.'} {r.simulated?'Downloads are clearly marked as simulations.':'This record does not show the wallet’s current balance.'}</p><div className="recovery-actions"><Button secondary disabled={busy} onClick={()=>download(r,'html')}><Icon name="download"/>Download {r.document==='receipt'?'receipt':'summary'}</Button><Button secondary disabled={busy} onClick={()=>download(r,'csv')}>Download CSV</Button></div><p className="fine-print">The receipt or summary is an HTML file. Open it in a browser to print or save as PDF. Downloads contain your wallet address and payment details; share them only when needed.</p></section>
  {state.orders?.some(o=>o.id===r.id)||state.fundingDrafts?.some(d=>d.id===r.id)?<Button secondary onClick={()=>open(r.hasOrder?'order':'funding-draft',r.id)}>View existing request</Button>:<p className="fine-print">This older request is available as a saved record. Its checkout controls are not loaded here.</p>}
 </article>;
 const content=<div className="payment-recovery"><p className="muted">Find the next step for a saved request and keep a record of its payment and wallet delivery.</p><div className="recovery-actions"><Button secondary disabled={busy} onClick={()=>setRefresh(x=>x+1)}>Reload saved status</Button><span className="fine-print">Uses Relay’s saved checks. This does not create a payment.</span></div>{error&&<Notice error>{error}</Notice>}{!loaded?<p role="status">Loading your funding records…</p>:selected?<>{record?detail(record):<Notice>This request is not available in your account.</Notice>}{!selectedId&&<Button secondary onClick={()=>setSelected(null)}>Back to funding records</Button>}</>:<><label className="field"><span>Show requests</span><select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All requests</option><option value="attention">Waiting or needs attention</option><option value="received">Wallet delivery confirmed</option></select></label><p className="fine-print">Shows the recent funding records available in your account. Live records and simulations are labelled separately.</p>{shown.length?<div className="recovery-list">{shown.map(r=><button className="recovery-card" key={r.id} onClick={()=>setSelected(r.id)}><span className="recovery-card-main"><strong>{r.agentName}</strong><span>{r.title}</span><small>{r.simulated?'Simulation · no real funds':'Live'} · {when(r.createdAt)}</small></span><span><strong>{value(r.requestedGbp,'GBP')}</strong><Icon name="arrow"/></span></button>)}</div>:<div className="empty"><Icon name="activity"/><p>No funding requests match this view.</p></div>}</>}</div>;
 return selectedId?<Modal title="Payment help and receipts" onClose={onClose}>{content}</Modal>:<section className="panel"><h2>Payment help and receipts</h2>{content}</section>;
}
