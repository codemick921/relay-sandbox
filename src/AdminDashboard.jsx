import React,{useEffect,useState} from 'react';
import {api} from './api';
import {Button,Field,Notice,Icon} from './ui';
import AccessPassword from './AccessPassword';
import {TestInvites} from './TestAccess';
import AdminPaymentHealth from './AdminPaymentHealth';
import './admin.css';
const when=v=>v?new Date(v).toLocaleString('en-GB',{timeZone:'Europe/London'}):'Not recorded';
const eventNames={admin_account_invited:'Admin setup requested',account_disable:'Account access paused',account_enable:'Account access restored',account_signout:'Account signed out',invitation_issued:'Invitation created',invitation_revoked:'Invitation revoked',invitation_joined_simulation:'Friend joined testing',invitation_mode_live:'Real funding selected',invitation_mode_simulation:'Simulation selected'};
function useAdminData(path,reload){
 const [state,setState]=useState({data:null,loading:true,error:''});
 useEffect(()=>{let active=true;setState({data:null,loading:true,error:''});api(path).then(data=>{if(active)setState({data,loading:false,error:''});}).catch(e=>{if(active)setState({data:null,loading:false,error:e.message});});return()=>{active=false;};},[path,reload]);
 return state;
}
export default function AdminDashboard({account}){
 const [tab,setTab]=useState('Overview'),[reload,setReload]=useState(0);
 return <div className="admin-dashboard">
  <section className="admin-intro"><span className="admin-mark"><Icon name="settings" size={28}/></span><div><span className="friend-badge">Administrator</span><h2>Your Eupova control centre.</h2><p>Manage testing access and accounts. Keep an eye on saved payment evidence.</p><span className="admin-identity">{account.email}</span></div></section>
  <nav className="admin-tabs" aria-label="Admin sections">{['Overview','Friend codes','Accounts','Payment health','Activity log'].map(name=><button type="button" key={name} aria-current={tab===name?'page':undefined} onClick={()=>setTab(name)}>{name}</button>)}</nav>
  {tab==='Friend codes'?<TestInvites/>:tab==='Payment health'?<AdminPaymentHealth/>:tab==='Accounts'?<Accounts/>:tab==='Activity log'?<Audit/>:<Overview reload={reload} onReload={()=>setReload(n=>n+1)} onTab={setTab}/>}
 </div>;
}
function Overview({reload,onReload,onTab}){
 const {data,loading,error}=useAdminData('admin/overview',reload);
 return <><div className="admin-section-head"><h2>At a glance</h2><Button secondary disabled={loading} onClick={onReload}>{loading?'Refreshing…':'Refresh overview'}</Button></div>{error&&<Notice error>{error}</Notice>}{loading&&<p role="status">Loading your admin overview…</p>}{data&&<>
  <div className="admin-stats">{[[data.accounts.total,'Accounts',`${data.accounts.verified} verified`,'Accounts'],[data.invitations.waiting,'Open invitations','Ready for a friend to join','Friend codes'],[data.invitations.joined,'Friends testing','Joined with active access','Friend codes'],[data.accounts.disabled,'Paused accounts','Sign-in is blocked','Accounts']].map(([n,title,note,target])=><button key={title} className="admin-stat" onClick={()=>onTab(target)}><span>{title}</span><strong>{n}</strong><small>{note}</small></button>)}</div>
  <div className="admin-overview-grid"><section className="admin-card admin-quick"><span className="friend-badge">Friend testing</span><h3>Give someone a place to try.</h3><p>Create a private, single-use code. Choose how long they have to join and whether they can request real funding.</p><Button onClick={()=>onTab('Friend codes')}>Manage friend codes<Icon name="arrow" size={18}/></Button></section><section className="admin-card"><h3>App status</h3><dl className="admin-status">{[['Real funding',data.services.liveFunding?'Enabled':'Disabled'],['Payment tracking',data.services.tracking?'Connected':'Not connected'],['Account email',data.services.email?'Enabled':'Disabled'],['Emails waiting',data.mail.queued],['Unconfirmed sends (24h)',data.mail.uncertain],['Accounts awaiting setup',data.accounts.pending]].map(([a,b])=><div key={a}><dt>{a}</dt><dd>{b}</dd></div>)}</dl><p className="admin-muted">These are configuration and queue states. Use Payment health to inspect saved tracking evidence.</p></section></div>
  <p className="admin-muted">Updated {when(data.generatedAt)} (UK time). Release {data.release?.slice(0,7)??'local test'}.</p>
 </>}</>;
}
function Accounts(){
 const [query,setQuery]=useState(''),[search,setSearch]=useState(''),[page,setPage]=useState(1),[reload,setReload]=useState(0),[selected,setSelected]=useState(null),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const {data,loading,error:loadError}=useAdminData('admin/accounts?'+new URLSearchParams({q:search,page:String(page)}),reload);
 function choose(account,action){setSelected({account,action});setPassword('');setError('');setMessage('');}
 async function submit(e){e.preventDefault();if(busy)return;setBusy(true);setError('');try{await api('admin/accounts/change',{id:selected.account.id,action:selected.action,currentPassword:password,confirm:true});setSelected(null);setMessage('Account access updated.');setReload(n=>n+1);}catch(e){setError(e.message);}finally{setPassword('');setBusy(false);}}
 const actionNames={disable:'Pause account',enable:'Restore account',signout:'Sign out all sessions'};
 return <section className="admin-card"><div className="admin-section-head"><h2>Accounts</h2><Button secondary disabled={loading||busy} onClick={()=>{setSelected(null);setReload(n=>n+1);}}>Refresh accounts</Button></div><form className="admin-search" onSubmit={e=>{e.preventDefault();setSelected(null);setSearch(query.trim());setPage(1);setReload(n=>n+1);}}><Field label="Find an account"><input type="search" maxLength={254} placeholder="Name or email" value={query} onChange={e=>setQuery(e.target.value)}/></Field><Button secondary disabled={busy}>Search</Button></form>
  {(loadError||error)&&<Notice error>{loadError||error}</Notice>}<p role="status">{message|| (loading?'Loading accounts…':'')}</p>
  {selected&&<form className="admin-confirm" aria-label="Confirm account change" onSubmit={submit}><h3>{actionNames[selected.action]}</h3><p><strong>{selected.account.email}</strong></p><p>{selected.action==='disable'?'This blocks new sign-ins, ends existing sessions and invalidates agent connections. Saved records remain. Restore access here when needed.':selected.action==='enable'?'This allows the person to sign in again. They keep their existing password and will need to reconnect any agents.':'This ends this person’s current sessions. They can sign in again using their password.'} Existing provider checkouts and payment tracking are unaffected.</p><AccessPassword id="admin-current-password" label="Your admin password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required disabled={busy}/><div className="admin-actions"><Button disabled={busy||!password}>{busy?'Updating…':'Confirm change'}</Button><Button secondary type="button" disabled={busy} onClick={()=>{setSelected(null);setPassword('');}}>Cancel</Button></div></form>}
  {data&&<><p className="admin-muted">{data.total} matching {data.total===1?'account':'accounts'}</p><div className="admin-account-list">{data.accounts.map(a=><article className="admin-account" key={a.id}><div><h3>{a.name}</h3><p>{a.email}</p><span className="friend-badge">{a.admin?'Administrator':a.disabled?'Access paused':a.pending?'Awaiting setup':a.verified?'Email verified':'Email unverified'}</span><p className="admin-muted">Created {when(a.createdAt)}</p></div><div className="admin-actions">{a.admin?<p className="admin-muted">Admin permissions are managed in deployment settings.</p>:<><Button secondary disabled={busy} onClick={()=>choose(a,a.disabled?'enable':'disable')}>{a.disabled?'Restore access':'Pause access'}</Button><Button secondary disabled={busy||a.disabled||a.pending} onClick={()=>choose(a,'signout')}>Sign out sessions</Button></>}</div></article>)}</div>{!data.accounts.length&&<p>No accounts match this search.</p>}<div className="admin-pagination"><Button secondary disabled={page===1||busy} onClick={()=>{setSelected(null);setPage(n=>n-1);}}>Previous</Button><span>Page {page}</span><Button secondary disabled={page*data.pageSize>=data.total||busy} onClick={()=>{setSelected(null);setPage(n=>n+1);}}>Next</Button></div></>}
 </section>;
}
function Audit(){
 const [reload,setReload]=useState(0);const {data,loading,error}=useAdminData('admin/audit',reload);
 return <section className="admin-card"><div className="admin-section-head"><div><h2>Activity log</h2><p>Latest 100 admin and testing events. All times are UK time.</p></div><Button secondary disabled={loading} onClick={()=>setReload(n=>n+1)}>Refresh activity</Button></div>{error&&<Notice error>{error}</Notice>}{loading&&<p role="status">Loading activity…</p>}{data&&<ol className="admin-audit">{data.events.map((e,i)=><li key={i}><strong>{eventNames[e.event]??e.event.replaceAll('_',' ')}</strong><p>{e.target}</p><small>{e.actor} · {when(e.at)}</small></li>)}</ol>}{data&&!data.events.length&&<p>No admin events have been recorded yet.</p>}</section>;
}
