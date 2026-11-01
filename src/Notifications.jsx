import React,{useEffect,useState,useRef,useCallback} from 'react';
import {api} from './api';
import {Button,Notice,Field,Check,Icon} from './ui';
import './notifications.css';
const stamp=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-GB',{timeZone:'Europe/London',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'Not recorded';
const dateLabel=value=>value&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value+'T12:00:00Z').toLocaleDateString('en-GB',{timeZone:'Europe/London',day:'numeric',month:'short',year:'numeric'}):'Not recorded';
const types={arrival:{label:'Wallet arrival',icon:'check',tone:'arrival'},attention:{label:'Payment update',icon:'info',tone:'attention'},balance:{label:'Balance alert',icon:'wallet',tone:'balance'},reminder:{label:'Funding reminder',icon:'clock',tone:'reminder'}};
export function useNotifications(accountId){
 const [view,setView]=useState({}),[filter,setFilter]=useState('all'),[page,setPage]=useState(1),[error,setError]=useState(''),[busy,setBusy]=useState(false),generation=useRef(0);
 const refresh=useCallback(async(sync=true)=>{if(!accountId)return;const g=++generation.current;setBusy(true);try{if(sync)await api('notifications/sync',{});const data=await api(`notifications?filter=${filter}&page=${page}`);if(g===generation.current){setView({accountId,filter,page,data});setError('');}}catch(e){if(g===generation.current)setError(e.message);}finally{if(g===generation.current)setBusy(false);}},[accountId,filter,page]);
 useEffect(()=>{setPage(1);setFilter('all');setView({});setError('');return()=>{generation.current++;};},[accountId]);
 useEffect(()=>{if(!accountId)return;refresh();const poll=()=>{if(!document.hidden)refresh();},timer=setInterval(poll,60000);document.addEventListener('visibilitychange',poll);return()=>{generation.current++;clearInterval(timer);document.removeEventListener('visibilitychange',poll);};},[refresh,accountId]);
 async function mutate(path,body){setBusy(true);setError('');try{await api('notifications/'+path,body);await refresh(path!=='read');return true;}catch(e){setError(e.message);setBusy(false);return false;}}
 const data=view.accountId===accountId&&view.filter===filter&&view.page===page?view.data:null;
 useEffect(()=>{if(data&&page>Math.max(1,data.pages))setPage(Math.max(1,data.pages));},[data,page]);
 return {data,error,busy,refresh,mutate,filter,page,setPage,setFilter:v=>{setFilter(v);setPage(1);}};
}

function UpdateCard({notice:n,busy,mutate,open,onWallets}){
 const type=types[n.kind]??{label:'Account update',icon:'info',tone:'general'};
 return <article className={'update-card update-card--'+type.tone+(!n.read_at?' is-unread':'')} aria-label={n.data.title}>
  <div className="update-symbol"><Icon name={type.icon} size={24}/></div>
  <div className="update-content">
   <div className="update-meta"><span className="update-kind">{type.label}</span><span className={'update-read '+(!n.read_at?'new':'')}>{n.read_at?'Read':'Unread'}</span>{n.simulated&&<span className="update-simulation">Simulation</span>}</div>
   <h3>{n.data.title}</h3><p>{n.data.message}</p>
   {n.kind==='balance'&&<dl className="update-amounts"><div><dt>Recorded balance</dt><dd>{n.data.amountUsdc!=null?n.data.amountUsdc+' USDC':'Unavailable'}</dd></div><div><dt>Your balance target</dt><dd>{n.data.targetUsdc!=null?n.data.targetUsdc+' USDC':'Not set'}</dd></div></dl>}
   {n.data.dueDate&&<p className="update-due">Reminder date: {dateLabel(n.data.dueDate)}</p>}
   <div className="update-actions">{n.data.requestId?<Button secondary onClick={()=>open('payment-help',n.data.requestId)}>View payment<Icon name="arrow" size={17}/></Button>:<Button secondary onClick={onWallets}>View wallets<Icon name="arrow" size={17}/></Button>}<button type="button" className="update-read-action" disabled={busy} onClick={()=>mutate('read',{id:n.id,read:!n.read_at})}>{n.read_at?'Mark as unread':'Mark as read'}</button></div>
   <details className="update-details"><summary>Update details</summary><dl><div><dt>Added</dt><dd>{stamp(n.created_at)} (UK time)</dd></div>{n.data.evidenceAt&&<div><dt>Evidence recorded</dt><dd>{stamp(n.data.evidenceAt)} (UK time)</dd></div>}{n.data.agentName&&<div><dt>Wallet</dt><dd>{n.data.agentName}</dd></div>}</dl><p>This is a saved update. Open the payment or wallet for its latest status.</p></details>
  </div>
 </article>;
}
export default function Notifications({inbox,agents,open,onWallets}){
 const {data,error,busy,refresh,mutate,filter,page,setPage,setFilter}=inbox;
 const [section,setSection]=useState('inbox'),[message,setMessage]=useState('');
 async function mark(body){setMessage('');if(await mutate('read',body))setMessage(body.all?'All updates marked as read.':body.read?'Update marked as read.':'Update marked as unread.');}
 return <div className="notification-centre">
  <div className="updates-top"><div><span className="updates-top-icon"><Icon name="activity" size={25}/></span><div><h2>{data?`${data.unread} unread ${data.unread===1?'update':'updates'}`:'Your updates'}</h2><p>Payment progress, wallet alerts and reminders.</p></div></div><Button secondary disabled={busy} onClick={()=>refresh()}>Refresh updates</Button></div>
  <div className="updates-sections" role="group" aria-label="Notification sections">{[['inbox','Inbox','activity'],['reminders','Reminders','clock'],['preferences','Preferences','check']].map(([key,label,icon])=><button key={key} type="button" aria-pressed={section===key} onClick={()=>setSection(key)}><Icon name={icon} size={18}/>{label}</button>)}</div>
  <p className="updates-channel"><Icon name="info" size={17}/>These updates appear in Eupova. They are not sent by email or phone.</p>
  {error&&<Notice error>{error} Your saved updates are retained. Try refreshing again.</Notice>}
  <p className="updates-feedback" role="status">{message}</p>
  {!data?<section className="updates-empty" aria-live="polite"><Icon name="activity" size={32}/><h2>{busy?'Loading your updates…':'Updates are unavailable'}</h2><p>{busy?'Your saved notifications will appear here.':'Refresh to try loading your notifications again.'}</p></section>:<>
   <section hidden={section!=='inbox'} aria-label="Notification inbox">
    <div className="updates-toolbar"><div className="updates-filters" role="group" aria-label="Filter updates"><button type="button" aria-pressed={filter==='all'} disabled={busy} onClick={()=>setFilter('all')}>All updates</button><button type="button" aria-pressed={filter==='unread'} disabled={busy} onClick={()=>setFilter('unread')}>Unread</button></div><Button secondary disabled={busy||!data.unread} onClick={()=>mark({all:true})}>Mark all as read</Button></div>
    {data.items.length?<div className="updates-list">{data.items.map(n=><UpdateCard key={n.id} notice={n} busy={busy} mutate={(path,body)=>mark(body)} open={open} onWallets={onWallets}/>)}</div>:<div className="updates-empty"><span className="updates-empty-icon"><Icon name="check" size={30}/></span><h2>{filter==='unread'?'You’re up to date':'No updates yet'}</h2><p>{filter==='unread'?'There are no unread updates. You can still review earlier notices.':'Saved payment updates, low-balance alerts and due reminders will appear here.'}</p>{filter==='unread'&&<Button secondary onClick={()=>setFilter('all')}>View all updates</Button>}</div>}
    {data.pages>1&&<div className="updates-pagination"><Button secondary disabled={busy||page<=1} onClick={()=>setPage(page-1)}>Previous</Button><span>Page {page} of {data.pages}</span><Button secondary disabled={busy||page>=data.pages} onClick={()=>setPage(page+1)}>Next</Button></div>}
    <p className="updates-last-check">Last saved-update check: {stamp(data.preferences.last_sync)} (UK time). Older notices may no longer reflect the current payment or balance.</p>
   </section>
   <section hidden={section!=='reminders'} aria-label="Funding reminders" className="updates-settings"><div className="updates-settings-head"><span className="updates-top-icon"><Icon name="clock" size={25}/></span><div><h2>Funding reminders</h2><p>A prompt to check your wallets, on a schedule you choose.</p></div></div><Notice>Reminders appear when you open Eupova. They never create a checkout or payment. Dates use UK time.</Notice>{!agents.length?<div className="updates-empty"><h3>Add a wallet first</h3><p>Save a receiving wallet before setting a reminder.</p><Button secondary onClick={onWallets}>View wallets</Button></div>:agents.map(a=><Reminder key={a.id} agent={a} saved={data.reminders.find(r=>r.agent_id===a.id)} busy={busy} mutate={mutate}/>)}<p className="updates-settings-note">If you miss several reminders, Eupova shows one when you return.</p></section>
   <section hidden={section!=='preferences'} aria-label="Notification preferences"><Preferences prefs={data.preferences} busy={busy} mutate={mutate} onWallets={onWallets}/></section>
  </>}
 </div>;
}
function Preferences({prefs,busy,mutate,onWallets}){
 const [form,setForm]=useState(prefs),[message,setMessage]=useState('');useEffect(()=>setForm(prefs),[prefs.payments,prefs.balances,prefs.simulations]);
 const changed=['payments','balances','simulations'].some(k=>form[k]!==prefs[k]);
 return <div className="updates-settings"><div className="updates-settings-head"><span className="updates-top-icon"><Icon name="check" size={25}/></span><div><h2>Choose your updates</h2><p>These choices affect new notices. Existing updates stay in your inbox.</p></div></div><div className="updates-preferences">{[['payments','Payment updates','Verified wallet arrivals and payments needing attention.'],['balances','Low-balance alerts','For wallets with balance alerts enabled.'],['simulations','Simulation updates','Example payment and balance notices, labelled as simulations.']].map(([key,label,hint])=><Check key={key} checked={!!form[key]} disabled={busy} onChange={e=>{setForm({...form,[key]:e.target.checked});setMessage('');}}><strong>{label}</strong><small>{hint}</small></Check>)}</div><div className="updates-preference-footer"><p>Set balance thresholds in My agents. Delayed or unavailable balances do not generate low-balance notices.</p><Button secondary onClick={onWallets}>Manage wallet alerts</Button></div><Button disabled={busy||!changed} onClick={async()=>{setMessage('');setMessage(await mutate('preferences',{payments:form.payments,balances:form.balances,simulations:form.simulations})?'Preferences saved.':'Preferences could not be saved. Try again.');}}>Save preferences</Button><p className="updates-feedback" role="status">{message}</p></div>;
}
function Reminder({agent,saved,busy,mutate}){
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const [enabled,setEnabled]=useState(saved?.enabled??false),[frequency,setFrequency]=useState(saved?.frequency??'monthly'),[date,setDate]=useState(saved?.next_due??today),[message,setMessage]=useState('');
 useEffect(()=>{setEnabled(saved?.enabled??false);setFrequency(saved?.frequency??'monthly');setDate(saved?.next_due??today);},[saved?.next_due,saved?.enabled,saved?.frequency]);
 return <details className="reminder-wallet"><summary><span className="reminder-wallet-symbol"><Icon name="wallet" size={22}/></span><span><strong>{agent.name}</strong><small>{saved?.enabled?`${saved.frequency==='weekly'?'Weekly':'Monthly'} · Next due ${dateLabel(saved.next_due)}`:'No active reminder'}</small></span><span className="reminder-state">{saved?.enabled?'Active':'Off'}</span></summary><form className="reminder-form" aria-label={`Reminder for ${agent.name}`} onSubmit={async e=>{e.preventDefault();setMessage('');const ok=await mutate('reminder',{agentId:agent.id,enabled,frequency,startDate:saved&&frequency===saved.frequency&&date===saved.next_due&&(!enabled||enabled===saved.enabled)?saved.start_date:date});setMessage(ok?(enabled?'Reminder saved.':'Reminder paused.'):'Reminder could not be saved. Try again.');}}><Check checked={enabled} disabled={busy} onChange={e=>{setEnabled(e.target.checked);setMessage('');}}>Enable funding reminder for {agent.name}</Check><div className="reminder-fields"><Field label={`Frequency for ${agent.name}`}><select disabled={busy||!enabled} value={frequency} onChange={e=>{setFrequency(e.target.value);setMessage('');}}><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></Field><Field label={`Next reminder for ${agent.name}`}><input type="date" disabled={busy||!enabled} required={enabled} min={enabled?today:undefined} value={date} onChange={e=>{setDate(e.target.value);setMessage('');}}/></Field></div><p className="updates-settings-note">Monthly reminders keep your chosen day, or the last day of a shorter month.</p><Button type="submit" secondary disabled={busy}>Save reminder</Button><p className="updates-feedback" role="status">{message}</p></form></details>;
}
