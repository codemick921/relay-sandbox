import AgentFundingRequests from './AgentFundingRequests';
import React,{useEffect,useRef,useState} from 'react';
import {api} from './api';
import {Button,Icon,Notice} from './ui';
import PaymentRecovery from './PaymentRecovery';
import FundingHistory from './FundingHistory';
import {paymentTone} from '../shared/payment-views.mjs';
import './payments.css';
const tabs=[['in_progress','In progress'],['received','Completed'],['requests','Funding requests'],['all','All payments'],['statements','Statements']];
const stamp=value=>value?new Date(value).toLocaleString('en-GB'):'Date unavailable';
export default function Payments({state,open,selectedId,onSelect,act,busy,error}){
 const [tab,setTab]=useState('in_progress');
 const heading=useRef(null),returnFocus=useRef(null);
 const select=id=>{returnFocus.current=document.activeElement;onSelect(id);};
 const back=()=>{onSelect(null);requestAnimationFrame(()=>{if(returnFocus.current?.isConnected)returnFocus.current.focus();else heading.current?.focus();});};
 const chooseTab=value=>{setTab(value);onSelect(null);};
 return <div className="payments-workspace">
  <div hidden={!!selectedId}>
   <h2 ref={heading} tabIndex={-1} className="payments-sr-only">Payment requests</h2>
   <div className="payments-toolbar">
   <div className="payments-tabs" role="tablist" aria-label="Payment views">{tabs.map(([key,label],i)=><button key={key} id={'payments-tab-'+key} type="button" role="tab" aria-selected={tab===key} aria-controls={'payments-panel-'+key} tabIndex={tab===key?0:-1} onClick={()=>chooseTab(key)} onKeyDown={e=>{let next;if(e.key==='ArrowRight')next=(i+1)%tabs.length;if(e.key==='ArrowLeft')next=(i+tabs.length-1)%tabs.length;if(e.key==='Home')next=0;if(e.key==='End')next=tabs.length-1;if(next!==undefined){e.preventDefault();chooseTab(tabs[next][0]);document.getElementById('payments-tab-'+tabs[next][0])?.focus();}}}>{label}</button>)}</div><Button onClick={()=>open('fund')}><Icon name="plus" size={18}/>Fund a wallet</Button></div>
   {tabs.map(([key])=><div key={key} role="tabpanel" id={'payments-panel-'+key} aria-labelledby={'payments-tab-'+key} hidden={tab!==key}>{key==='requests'?tab==='requests'&&<AgentFundingRequests {...{state,open,act,busy,error}}/>:key==='statements'?tab==='statements'&&<FundingHistory open={(kind,id)=>kind==='payment-help'?select(id):open(kind,id)}/>:<PaymentList active={tab===key&&!selectedId} status={key} state={state} onSelect={select}/>}</div>)}
  </div>
  {selectedId&&<section className="payments-detail-page"><PaymentRecovery key={selectedId} state={state} open={open} selectedId={selectedId} embedded onBack={back}/></section>}
 </div>;
}
function PaymentList({active,status,state,onSelect}){
 const [query,setQuery]=useState(''),[search,setSearch]=useState(''),[source,setSource]=useState('live'),[page,setPage]=useState(1),[snapshot,setData]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0);
 const requestKey=JSON.stringify([status,source,search,page]),data=snapshot?.key===requestKey?snapshot.result:null;
 useEffect(()=>{if(!active)return;let current=true;setLoading(true);setError('');
  api('funding-history?'+new URLSearchParams({status,source,q:search,page:String(page)})).then(result=>{if(!current)return;if(page>Math.max(1,result.pages)){setPage(Math.max(1,result.pages));return;}setData({key:requestKey,result});}).catch(e=>{if(current){setData(null);setError(e.message);}}).finally(()=>{if(current)setLoading(false);});return()=>{current=false;};
 },[active,status,source,search,page,requestKey,reload,state.orders,state.fundingDrafts]);
 const label=status==='in_progress'?'In progress':status==='received'?'Completed':'All payments';
 return <section className="panel payments-list-panel" aria-label={label+' requests'}>
  <div className="payments-list-title"><div><h3>{label}</h3><p>{status==='in_progress'?'Drafts, ongoing requests and payments needing attention.':status==='received'?'Requests with confirmed wallet delivery.':'Your saved requests, including cancelled and closed requests.'}</p></div><Button secondary disabled={loading} onClick={()=>setReload(x=>x+1)}>Refresh</Button></div>
  <details className="payments-filter-panel"><summary>Search and filters</summary><form className="payments-search" onSubmit={e=>{e.preventDefault();setSearch(query.trim());setPage(1);setReload(x=>x+1);}}><label className="field"><span>Search payments</span><input maxLength={128} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Wallet name, address or request ID"/></label><label className="field"><span>Show</span><select value={source} onChange={e=>{setSource(e.target.value);setPage(1);}}><option value="live">Live requests</option><option value="simulated">Simulations</option></select></label><Button secondary type="submit" disabled={loading}>Search</Button></form></details>
  {source==='simulated'&&<Notice>Simulation records only. These do not confirm real payments or wallet arrivals.</Notice>}
  {error?<Notice error>{error} <button type="button" className="text-button" onClick={()=>setReload(x=>x+1)}>Try again</button></Notice>:!data?<p role="status" className="payments-loading">Loading payments…</p>:data&&<>
   <p className="payments-result-count" role="status">{data.total} {data.total===1?'request':'requests'}{search?' matching your search':''}</p>
   {data.records.length?<div className="payments-list">{data.records.map(r=><button key={r.id} type="button" className={'payment-list-row payment-tone-'+paymentTone(r)} onClick={()=>onSelect(r.id)}><span className="payment-row-icon"><Icon name={r.deliveryConfirmed?'check':r.code==='draft'?'activity':'clock'}/></span><span className="payment-row-main"><strong>{r.agentName}</strong><span>{r.title}</span><small>{stamp(r.createdAt)}{r.simulated?' · Simulation':''}</small></span><span className="payment-row-amount"><strong>{r.requestedAmount===null?'Amount unavailable':`${r.requestedAmount} ${r.currency}`}</strong><small>Requested</small>{r.confirmedUsdc!==null&&<small>{r.confirmedUsdc} USDC {r.deliveryConfirmed?'received':'recorded'}</small>}</span><Icon name="arrow" size={20}/></button>)}</div>:<div className="payments-empty"><span className="payments-symbol"><Icon name={status==='received'?'check':'activity'} size={28}/></span><h3>{search?'No matching requests':status==='received'?'No completed payments yet':status==='in_progress'?'No requests in progress':'No payment records yet'}</h3><p>{search?'Try a different wallet name, address or request ID.':status==='received'?'Payments appear here once wallet delivery is confirmed.':status==='in_progress'?'Find earlier requests in All payments or start from Fund a wallet above.':'Your funding requests and their updates will appear here.'}</p>{search&&<Button secondary onClick={()=>{setQuery('');setSearch('');setPage(1);}}>Clear search</Button>}</div>}
   {data.pages>1&&<div className="payments-pagination"><Button secondary disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Previous</Button><span>Page {page} of {data.pages}</span><Button secondary disabled={page>=data.pages} onClick={()=>setPage(p=>p+1)}>Next</Button></div>}
   <p className="fine-print payments-saved-at">Saved records loaded {stamp(data.generatedAt)}. Open a request for its last successful payment check.</p>
  </>}
 </section>;
}
