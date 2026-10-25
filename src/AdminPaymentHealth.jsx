import TrackingNotice from './TrackingNotice';
import React,{useEffect,useRef,useState} from 'react';
import {api} from './api';
import {Button,Notice} from './ui';
import './payment-health.css';

const labels={attention:'Needs attention',all:'All tracked orders',review:'Evidence review',retry:'Failed checks',overdue:'Overdue checks',partial:'Part payments',stopped_funds:'Stopped with settlement'};
const notificationReasons={no_order_reference:'No order reference was saved. This notification cannot be linked from the available evidence.',no_saved_order:'No matching Eupova order is saved for this merchant. This may concern a checkout outside Eupova; its relevance is unconfirmed.',linked_since_receipt:'A matching order is now saved, but this notification was unmatched when received. No replay or payment change has been made.',queued:'Saved for a matching order and awaiting a successful verification check. The notification itself does not confirm payment.'};
const when=value=>value?new Date(value).toLocaleString('en-GB'):'Not recorded';
const amount=value=>value===null?'Not recorded':value+' USDC';
export default function AdminPaymentHealth(){
 const detailRef=useRef(null);
 const [source,setSource]=useState('live'),[filter,setFilter]=useState('attention'),[page,setPage]=useState(1),[selected,setSelected]=useState(null),[reload,setReload]=useState(0);
 const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let active=true;setBusy(true);setError('');setData(null);
  const params=new URLSearchParams({source,filter,page:String(page),...selected?{id:selected}:{}});
  api('operator/payment-health?'+params).then(result=>{if(active)setData(result);}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setBusy(false);});
  return()=>{active=false;};
 },[source,filter,page,selected,reload]);
 const choose=(setter,value)=>{setter(value);setPage(1);setSelected(null);};
 const detail=data?.detail,r=detail?.record;
 useEffect(()=>{if(data?.detail){detailRef.current?.scrollIntoView({block:'start'});detailRef.current?.focus({preventScroll:true});}},[data?.detail]);
 return <div className="payment-health">
  <Notice>Admin access · saved evidence only. Reload reads Eupova’s database. It does not contact a payment provider, retry a check or change a payment.</Notice>
  <div className="health-controls">
   <label>Evidence source<select value={source} onChange={e=>choose(setSource,e.target.value)}><option value="live">Live tracking records</option><option value="simulated">Simulated tracking records</option></select></label>
   <label>Show<select value={filter} onChange={e=>choose(setFilter,e.target.value)}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <Button disabled={busy} onClick={()=>setReload(n=>n+1)}>{busy?'Reading saved evidence…':'Reload saved evidence'}</Button>
  </div>
  {source==='simulated'&&<Notice>Simulation only. These records do not confirm real payments or wallet arrivals.</Notice>}
  {error&&<Notice error>{error} Saved evidence could not be loaded. No payment status was changed.</Notice>}
  {busy&&<p role="status">Reading saved payment records…</p>}
  {data&&!data.available&&<Notice>{data.reason} No totals or health assessment are available.</Notice>}
  {data?.available&&<>
   <p className="fine-print">Snapshot read: {when(data.generatedAt)}. Evidence dates are shown separately. Counts can overlap.</p>
   <div className="health-stats">{['attention','review','retry','overdue','partial','stopped_funds'].map(key=><button key={key} aria-pressed={filter===key} onClick={()=>choose(setFilter,key)}><strong>{data.counts[key]}</strong><span>{labels[key]}</span></button>)}</div>
   <section className="panel health-monitor" aria-label="Tracking health"><h2>Tracking health</h2><dl className="details">
    <div><dt>Checker heartbeat</dt><dd>{({recent:'Recent heartbeat',stale:'Heartbeat is stale',unknown:'No heartbeat recorded'})[data.worker.status]}</dd></div>
    <div><dt>Last heartbeat</dt><dd>{when(data.worker.heartbeatAt)}</dd></div>
    <div><dt>Pending notifications</dt><dd>{data.notifications.pending}</dd></div>
    <div><dt>Oldest pending notification</dt><dd>{when(data.notifications.oldestPendingAt)}</dd></div>
    <div><dt>Unmatched notifications</dt><dd>{data.notifications.unmatched}</dd></div>
    <div><dt>Last saved notification</dt><dd>{when(data.notifications.lastReceivedAt)}</dd></div>
   </dl><p className="fine-print">A recent heartbeat shows that the checker reported in within 90 seconds. It does not prove that a payment succeeded. An unfinished order is overdue when its scheduled check is more than five minutes late. Unmatched notifications may concern orders outside Eupova.</p></section>
   <section className="panel" aria-label="Notification diagnostics"><h2>Notification diagnostics</h2><p>Saved unmatched or unprocessed notifications. These details do not approve, retry or change a payment.</p>
    {data.notifications.diagnostics?.length?<ol className="health-timeline">{data.notifications.diagnostics.map((n,i)=><li key={i}><strong>{n.event}</strong><time>{when(n.receivedAt)}</time><p>{notificationReasons[n.reason]??'The saved evidence does not establish a match.'}</p>{n.relayOrderId&&<Button secondary onClick={()=>setSelected(n.relayOrderId)}>View saved order</Button>}</li>)}</ol>:<p>No unmatched or unprocessed notifications are saved.</p>}
    {data.notifications.diagnosticsTruncated&&<p>Showing the latest 25 notifications. The totals above include older entries.</p>}
   </section>
   <section className="panel" aria-label="Payment attention queue"><div className="section-head"><h2>{labels[filter]}</h2><span>{data.counts[filter]} {data.counts[filter]===1?'order':'orders'}</span></div>
    {data.records.length?<div className="health-orders">{data.records.map(item=><button className="health-order" key={item.record.id} aria-pressed={selected===item.record.id} onClick={()=>setSelected(item.record.id)}><span><strong>{item.record.agentName}</strong><small>{item.record.title}</small><small className="mono">{item.record.id}</small></span><span><strong>{item.record.requestedGbp===null?'Amount not recorded':'£'+item.record.requestedGbp}</strong><small>{item.flags.map(f=>labels[f]).join(' · ')||'No attention flags'}</small><small>Last check: {when(item.record.checkedAt)}</small></span></button>)}</div>:<p>No saved orders match this filter.</p>}
    <div className="health-pagination"><Button disabled={page===1||busy} onClick={()=>{setSelected(null);setPage(p=>p-1);}}>Previous</Button><span>Page {page}</span><Button disabled={page*data.pageSize>=data.counts[filter]||busy} onClick={()=>{setSelected(null);setPage(p=>p+1);}}>Next</Button></div>
   </section>
   {r&&<section ref={detailRef} tabIndex={-1} className="panel health-detail" aria-label="Saved payment evidence"><div className="section-head"><h2>Saved payment evidence</h2><Button onClick={()=>setSelected(null)}>Close detail</Button></div><h3>{r.agentName} · {r.title}</h3>
    <TrackingNotice tracking={r.tracking} expiry={r.attemptExpiry}/><p>Use this saved record to investigate the request. This screen cannot approve a payment or override wallet verification.</p>{r.stopped&&<Notice>Stopped in Eupova. The provider order was not cancelled by this action. Any later settlement stays linked to this request.</Notice>}
    <dl className="details"><div><dt>Eupova request</dt><dd className="mono">{r.id}</dd></div><div><dt>Peer order</dt><dd className="mono">{r.providerOrderId}</dd></div><div><dt>Receiving address</dt><dd className="mono">{r.address}</dd></div><div><dt>Network and token</dt><dd>{r.network} · {r.token}</dd></div><div><dt>Created</dt><dd>{when(r.createdAt)}</dd></div><div><dt>Last successful check</dt><dd>{when(r.checkedAt)}</dd></div><div><dt>Latest failed or pending attempt</dt><dd>{when(detail.lastAttemptAt)}</dd></div><div><dt>Consecutive failed checks</dt><dd>{detail.failedChecks}</dd></div><div><dt>Next scheduled check</dt><dd>{when(detail.nextCheckAt)}</dd></div><div><dt>Stopped in Eupova</dt><dd>{when(detail.stoppedAt)}</dd></div><div><dt>Provider fulfilment saved</dt><dd>{r.providerFulfilled?'Fulfilled':'Not confirmed'}</dd></div><div><dt>Net settlement saved</dt><dd>{amount(r.netUsdc)}</dd></div><div><dt>Finalised arrival saved</dt><dd>{amount(r.confirmedUsdc)}</dd></div><div><dt>Complete wallet receipt</dt><dd>{r.deliveryConfirmed?(r.simulated?'Simulated receipt':'Verified receipt saved'):'Not confirmed'}</dd></div></dl>
    {r.receipts.length>0&&<><h3>Finalised transfers</h3><ul>{r.receipts.map(receipt=><li key={receipt.transactionHash}><span className="mono">{receipt.transactionHash}</span><p>{receipt.amountUsdc} USDC · Base block {receipt.blockNumber}</p></li>)}</ul></>}
    {detail.reconciliation&&<section aria-label="Saved evidence reconciliation"><h3>Saved evidence reconciliation</h3>
     <Notice error={['inconsistent','attention'].includes(detail.reconciliation.status)}>{({matched:'The saved request, settlement ledger and wallet receipt agree.',incomplete:'Some evidence is still pending or was not saved. Reconciliation is incomplete.',inconsistent:'Saved records disagree. Investigate the checks below before treating this request as reconciled.',attention:'A dispute or review hold needs attention. A historical wallet receipt does not resolve it.'})[detail.reconciliation.status]}</Notice>
     <p>This compares Eupova’s saved records. It does not query Peer or Base, prove the wallet’s current balance, or change a payment. The last successful check is shown above.</p>
     <dl className="details">{detail.reconciliation.checks.map(check=><div key={check.code}><dt>{check.label}</dt><dd>{check.code==='holds'&&check.status==='pass'?'None recorded':({pass:'Matches',pending:'Pending',unavailable:'Not saved',mismatch:'Does not match',attention:'Needs attention'})[check.status]}</dd></div>)}</dl>
    </section>}
    <h3>Saved event timeline</h3>{detail.timeline.length?<ol className="health-timeline">{detail.timeline.map((event,i)=><li key={i}><strong>{event.label}</strong><time>{when(event.at)}</time></li>)}</ol>:<p>No audit events were saved for this order.</p>}
    <p className="fine-print">{detail.timelineTruncated?'Showing the latest 100 events. ':''}Newest events first. Event dates record when Eupova saved the evidence; they are not necessarily the bank payment or blockchain confirmation time. Private checkout links and raw diagnostic payloads are excluded.</p>
   </section>}
  </>}
 </div>;
}
