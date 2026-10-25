import React,{useEffect,useState} from 'react';
import {api} from './api';
import {Button,Notice} from './ui';
import './funding-history.css';
const initial={source:'live',status:'all',q:'',address:'',from:'',to:''};
const dates=v=>v?new Date(v).toLocaleString('en-GB',{timeZone:'Europe/London'}):'Not available';
const statuses=[['all','All statuses'],['draft','Saved drafts'],['awaiting','Waiting for payment'],['uncertain','Checkout needs attention'],['partial','Part payments'],['settled','Checking wallet arrival'],['confirming','Waiting for network confirmation'],['stopped','Stopped in Eupova'],['ended','Cancelled or closed'],['review','Needs review'],['received','Wallet delivery confirmed'],['disputed','Disputed']];
export default function FundingHistory({open}){
 const [form,setForm]=useState(initial),[filters,setFilters]=useState(initial),[page,setPage]=useState(1),[data,setData]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[downloading,setDownloading]=useState(false),[month,setMonth]=useState(''),[reload,setReload]=useState(0);
 const query=new URLSearchParams({...filters,page:String(page)}).toString();
 useEffect(()=>{let active=true;setLoading(true);setError('');api('funding-history?'+query).then(d=>{if(active)setData(d);}).catch(e=>{if(active){setData(null);setError(e.message);}}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[query,reload]);
 const change=(key,value)=>setForm(f=>({...f,[key]:value}));
 function chooseMonth(v){setMonth(v);if(!/^\d{4}-\d{2}$/.test(v))return;const [y,m]=v.split('-').map(Number),end=new Date(Date.UTC(y,m,0)).getUTCDate();setForm(f=>({...f,from:v+'-01',to:v+'-'+end}));}
 async function download(format){setDownloading(true);setError('');try{
  const qs=new URLSearchParams({...filters,format});const response=await fetch('/api/funding-history/download?'+qs);
  if(!response.ok){const d=await response.json();if(response.status===401)window.dispatchEvent(new Event('relay-session-expired'));throw Error(d.error??'The statement is unavailable.');}
  const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]??`eupova-statement.${format}`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(e){setError(e.message);}finally{setDownloading(false);}}
 const dirty=JSON.stringify(form)!==JSON.stringify(filters),blocked=loading||downloading||dirty;
 return <section className="panel funding-history"><h2>Funding history and statements</h2><p className="muted">Search your saved requests, including older payments, and download a statement for the period you choose.</p>
 <form className="history-filters" onSubmit={e=>{e.preventDefault();setPage(1);setFilters({...form});setReload(x=>x+1);}}>
  <label className="field history-search"><span>Search agent or request</span><input value={form.q} maxLength={128} placeholder="Agent name, request ID or wallet address" onChange={e=>change('q',e.target.value)}/></label>
  <label className="field"><span>Records</span><select value={form.source} onChange={e=>change('source',e.target.value)}><option value="live">Live requests and drafts</option><option value="simulated">Simulations only</option><option value="all">All records</option></select></label>
  <label className="field"><span>Status</span><select value={form.status} onChange={e=>change('status',e.target.value)}>{statuses.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
  <label className="field"><span>Receiving wallet (optional)</span><input value={form.address} maxLength={42} placeholder="0x…" onChange={e=>change('address',e.target.value)}/></label>
  <label className="field"><span>Statement month</span><input type="month" value={month} onChange={e=>chooseMonth(e.target.value)}/></label>
  <label className="field"><span>Created from</span><input type="date" value={form.from} onChange={e=>{setMonth('');change('from',e.target.value);}}/></label>
  <label className="field"><span>Created through</span><input type="date" value={form.to} onChange={e=>{setMonth('');change('to',e.target.value);}}/></label>
  <div className="history-actions"><Button type="submit" disabled={loading}>Apply filters</Button><Button secondary type="button" onClick={()=>{setForm(initial);setFilters(initial);setMonth('');setPage(1);setReload(x=>x+1);}}>Clear filters</Button></div>
 </form>
 <p className="fine-print">Dates use London time and the date each request was created. The statement includes its latest saved details, including any later arrival. It is not a list of transfers made during that month.</p>
 {error&&<Notice error>{error}</Notice>}{dirty&&<Notice>Apply your filters to update the results and downloads.</Notice>}
 {loading?<p role="status">Loading your funding history…</p>:data&&<>
 <div className="section-head"><h3>{data.total} {data.total===1?'request':'requests'}</h3><Button secondary disabled={downloading} onClick={()=>setReload(x=>x+1)}>Reload saved history</Button></div>
 {filters.source==='all'?<Notice>Choose live requests or simulations to see totals and download a statement. Test amounts are kept separate from real funding.</Notice>:<>
 {filters.source==='simulated'&&<Notice>Simulation only. These amounts do not confirm real payments or wallet arrivals.</Notice>}
 <div className="history-totals">{[['requestedGbp','Requested','GBP'],['netUsdc','After Peer fees','USDC'],['confirmedUsdc','Arrival confirmed','USDC'],['peerFeeUsdc','Peer fees','USDC']].map(([k,l,u])=><div key={k}><span>{l}</span><strong>{data.summary[k].amount===null?'Not available':`${data.summary[k].amount} ${u}`}</strong><small>{data.summary[k].known} recorded · {data.summary[k].missing} unavailable</small></div>)}</div>
 <p>Payments recorded by Peer: {Object.entries(data.summary.recordedFiat).length?Object.entries(data.summary.recordedFiat).map(([c,v])=>`${v.amount} ${c} (${v.known} recorded)`).join('; '):'Not available'}. Requests with no recorded payment amount: {data.summary.fiatMissing}.</p>
 <p className="fine-print">Totals cover all matching requests, across every page. Requested GBP is not proof of payment. Missing amounts are not zero. Bank fees and any markup in the seller’s exchange rate are not included. {data.summary.disputed>0&&`Requests with a dispute: ${data.summary.disputed}. Any confirmed arrivals remain historical records.`}</p>
 <div className="history-actions"><Button secondary disabled={blocked} onClick={()=>download('csv')}>Download statement CSV</Button><Button secondary disabled={blocked} onClick={()=>download('html')}>Download printable statement</Button></div>
 <p className="fine-print">Open the printable HTML file in your browser to print or save as PDF. Downloads include wallet addresses and payment details. Each download reads the latest saved details; it may differ from this view. For more than 10,000 records, choose a shorter date range.</p>
 </>}
 <div className="history-list">{data.records.length?data.records.map(r=><article className="history-card" key={r.id}><div><span className="status-pill">{r.simulated?'Simulation · no real funds':r.source==='draft'?'Saved draft':'Live funding record'}</span><h3>{r.agentName}</h3><p>{r.title}</p><small>{dates(r.createdAt)} · London time</small><code>{r.address??'Address not available'}</code></div><div><strong>{r.requestedGbp===null?'Amount unavailable':`£${r.requestedGbp} requested`}</strong><small>{r.confirmedUsdc===null?'Arrival not confirmed':`${r.confirmedUsdc} USDC arrival confirmed`}</small><Button secondary onClick={()=>open('payment-help',r.id)}>View funding record</Button></div></article>):<p className="empty">No saved requests match these filters.</p>}</div>
 <div className="history-actions" aria-label="History pagination"><Button secondary disabled={blocked||page<=1} onClick={()=>setPage(p=>p-1)}>Previous</Button><span>Page {page} of {Math.max(data.pages,1)}</span><Button secondary disabled={blocked||page>=data.pages} onClick={()=>setPage(p=>p+1)}>Next</Button></div><p className="fine-print">Saved records loaded: {dates(data.generatedAt)} London time. This view does not check with a payment provider or create a payment.</p>
 </>}
 </section>;
}
