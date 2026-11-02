import React,{useEffect,useState} from 'react';
import {api} from './api';
import {Button,Icon} from './ui';
import FundingHome,{FundingRoute} from './FundingHome';
import FundingTerms from './FundingTerms';
import {fundingEntry} from './funding-entry.mjs';
import './returning-overview.css';

const date=value=>value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(value)):null;
function RequestCard({record,attention,onView}){
 const amount=record.requestedAmount??record.requestedGbp,checked=date(record.checkedAt);
 return <article className={'overview-request'+(attention?' overview-request--attention':'')}>
  <div className="overview-request-top"><span className="overview-wallet-icon"><Icon name={attention?'info':'wallet'} size={21}/></span><div><h3>{record.agentName||'Saved wallet'}</h3><p>{amount!==null&&amount!==undefined?`${amount} ${record.currency??'GBP'} requested`:'Requested amount unavailable'}</p></div></div>
  <strong className="overview-status">{record.title||'Status not available'}</strong>
  {attention?<p className="overview-next">{record.next||'Open this request to check the saved details.'}</p>:<div className="overview-evidence"><span><Icon name={record.providerFulfilled?'check':'clock'} size={16}/>{record.providerFulfilled?'Peer confirmed payment':'Peer payment not confirmed'}</span><span><Icon name={record.deliveryConfirmed?'check':'clock'} size={16}/>{record.deliveryConfirmed?'USDC arrival confirmed':'USDC arrival not confirmed'}</span></div>}
  <p className="overview-checked">{checked?<>Last payment check <time dateTime={record.checkedAt}>{checked}</time></>:'No payment check recorded'}{record.trackingUnavailable?' · Tracking unavailable':record.stale?' · Check is older than 15 minutes':''}</p>
  <Button secondary={!attention} onClick={()=>onView(record.id)}>{attention?'Review request':'View progress'}<Icon name="arrow" size={17}/></Button>
 </article>;
}
export default function ReturningOverview({state,open,onWallets,onViewPayment}){
 const [data,setData]=useState(null),[error,setError]=useState(false),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0);
 const simulation=state.testAccess?.mode==='simulation';
 useEffect(()=>{
  if(simulation)return;
  let active=true,busy=false;
  const load=async()=>{if(busy)return;busy=true;setLoading(true);try{const next=await api('funding-overview');if(active){setData(next);setError(false);}}catch{if(active)setError(true);}finally{busy=false;if(active)setLoading(false);}};
  load();const timer=setInterval(()=>{if(document.visibilityState==='visible')load();},30000);
  const visible=()=>{if(document.visibilityState==='visible')load();};document.addEventListener('visibilitychange',visible);
  return()=>{active=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[retry,simulation]);
 const returning=!!(state.agents?.length||state.orders?.length||state.fundingDrafts?.length||data?.total);
 const entry=fundingEntry(state);
 const refresh=<Button secondary disabled={loading} onClick={()=>setRetry(n=>n+1)}>{loading?'Refreshing…':'Try again'}</Button>;
 if(simulation)return <FundingHome state={state} open={open} onWallets={onWallets}/>;
 if(!returning)return <>{error&&<div className="overview-load-message" role="status"><span>We couldn’t load your saved requests. Check Payments before starting another request.</span>{refresh}<Button secondary onClick={()=>onViewPayment(null)}>View payments</Button></div>}<FundingHome state={state} open={open} onWallets={onWallets}/></>;
 const shortcuts=<section className="overview-shortcuts" aria-label="Funding shortcuts"><div><p className="funding-eyebrow">Your agentic wallets</p><h2>Keep your funding moving.</h2><p>Check your live requests or fund a saved wallet.</p></div><div className="overview-shortcut-buttons">{entry&&<Button disabled={entry.disabled} onClick={()=>open(entry.kind,entry.id,entry.needsWallet?{continueFunding:true}:undefined)}>{entry.label}<Icon name="arrow" size={18}/></Button>}<Button secondary onClick={onWallets}><Icon name="wallet" size={18}/>Manage wallets</Button><Button secondary onClick={()=>open('fund')}>View funding options</Button></div></section>;
 return <div className="returning-overview">

  {error&&<div className="overview-load-message" role="status"><span>{data?'We couldn’t refresh your requests. The last loaded details are shown below.':'We couldn’t load your requests. Open Payments to check their status.'}</span>{refresh}<Button secondary onClick={()=>onViewPayment(null)}>View payments</Button></div>}
  {!data&&!error&&<p className="overview-load-message" role="status">Loading your saved requests…</p>}
  {!data&&shortcuts}
  {data&&<>
   {data.attention.total>0?<section className="overview-section overview-attention" aria-labelledby="overview-attention-title"><div className="overview-section-heading"><div><p className="funding-eyebrow">Check these first</p><h2 id="overview-attention-title">Needs attention <span>{data.attention.total}</span></h2></div><Button secondary onClick={()=>onViewPayment(null)}>View payments</Button></div><div className="overview-card-grid">{data.attention.records.map(r=><RequestCard key={r.id} record={r} attention onView={onViewPayment}/>)}</div>{data.attention.total>data.attention.records.length&&<p className="overview-more">Showing the latest {data.attention.records.length} of {data.attention.total} requests needing attention. View Payments for the full history.</p>}</section>:!error&&<div className="overview-clear"><Icon name="check" size={20}/><span>No live requests flagged for attention in your saved records.</span></div>}
   {shortcuts}
   <section className="overview-section" aria-labelledby="overview-progress-title"><div className="overview-section-heading"><div><p className="funding-eyebrow">Follow your requests</p><h2 id="overview-progress-title">In progress <span>{data.progress.total}</span></h2></div><Button secondary onClick={()=>onViewPayment(null)}>View all payments</Button></div>{data.progress.total?<><div className="overview-card-grid">{data.progress.records.map(r=><RequestCard key={r.id} record={r} onView={onViewPayment}/>)}</div>{data.progress.total>data.progress.records.length&&<p className="overview-more">Showing the latest {data.progress.records.length} of {data.progress.total} in-progress requests. Requests needing attention are shown separately above.</p>}</>:<div className="returning-empty"><Icon name="clock" size={24}/><p>{data.attention.total?'Your open requests are in Needs attention above.':'No funding requests in progress.'}</p></div>}</section>
   <p className="overview-snapshot">Saved records loaded <time dateTime={data.generatedAt}>{date(data.generatedAt)??'at an unknown time'}</time>. Payment check times are shown on each request.</p>
  </>}
  <details className="overview-guide"><summary><span><Icon name="convert" size={21}/><strong>How funding works</strong></span><span className="overview-mini-route">Your currency <Icon name="arrow" size={16}/> Peer <Icon name="arrow" size={16}/> USDC on Base</span></summary><div className="overview-guide-content"><FundingRoute live={!!state.liveFunding?.paymentsEnabled}/><FundingTerms/></div></details>
 </div>;
}
