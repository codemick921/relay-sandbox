import React,{useEffect,useState,useRef} from 'react';
import {api} from './api';
import {Button,Field,Notice,Icon} from './ui';
import AccessPassword from './AccessPassword';
import './account-security.css';
const date=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('en-GB',{timeZone:'Europe/London',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'Not confirmed';
const eventNames={recovery_confirmed:'Recovery code confirmed',recovery_rotated:'Recovery code replaced',session_revoked:'A session was signed out',other_sessions_revoked:'Other sessions were signed out',wallet_added:'Receiving wallet saved',wallet_updated:'Receiving wallet updated'};
export default function AccountSecurity({onRecovery}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[password,setPassword]=useState(''),[code,setCode]=useState(''),[pending,setPending]=useState(null);
 const generation=useRef(0),confirmRef=useRef(null);
 async function load(){const g=++generation.current;setLoading(true);try{const r=await api('account/security',{});if(g===generation.current){setData(r);setError('');}}catch(e){if(g===generation.current)setError(e.message);}finally{if(g===generation.current)setLoading(false);}}
 useEffect(()=>{load();return()=>{generation.current++;};},[]);
 useEffect(()=>{if(pending){confirmRef.current?.scrollIntoView({behavior:'instant',block:'center'});confirmRef.current?.focus();}},[pending]);
 function choose(value){setPending(value);setPassword('');setCode('');setError('');setMessage('');}
 async function run(route,body){if(busy)return;setBusy(true);setError('');setMessage('');try{const r=await api('account/'+route,body);setPassword('');setCode('');setPending(null);if(r.recoveryCode)onRecovery(r.recoveryCode);else{setMessage(r.message);await load();}}catch(e){setError(e.message);setPassword('');setCode('');}finally{setBusy(false);}}
 const locked=busy||loading,sessions=data?[...data.sessions].sort((a,b)=>Number(b.current)-Number(a.current)):[];
 return <div className="account-security-tools">
  {error&&<div className="security-feedback"><Notice error>{error}{data?' Your last loaded security details are still shown.':''}</Notice></div>}
  {message&&<p className="security-feedback" role="status">{message}</p>}
  <section className="security-card security-recovery" id="security-recovery" tabIndex={-1} aria-label="Recovery code">
   <div className="security-card-heading"><span className="security-symbol"><Icon name="check" size={25}/></span><h2>Recovery code</h2></div>
   {!data?<><p role="status">{loading?'Loading recovery details…':'Security details are unavailable.'}</p><Button secondary disabled={loading} onClick={load}>Try again</Button></>:<>
    <span className={'security-badge '+(data.recoveryConfirmedAt?'':'security-badge--attention')}>{data.recoveryConfirmedAt?'Saved code confirmed':'Check your saved code'}</span>
    <p>Keep your current code in your password manager. You can use it with your email address to reset your Eupova password.</p>
    {data.recoveryConfirmedAt&&<p className="security-meta">Confirmed {date(data.recoveryConfirmedAt)} (UK time)</p>}
    <details className="security-disclosure" onToggle={e=>{if(!e.currentTarget.open)setCode('');}}><summary>Confirm my saved recovery code</summary><p>Enter the latest code. This checks it without replacing it.</p><form aria-label="Confirm saved recovery code" onSubmit={e=>{e.preventDefault();run('confirmRecovery',{recoveryCode:code});}}><Field label="Saved recovery code"><input disabled={locked} required type="password" autoComplete="off" minLength={64} maxLength={64} value={code} onChange={e=>setCode(e.target.value.trim())}/></Field><Button secondary disabled={locked||code.length!==64}>Confirm saved code</Button></form></details>
    <Button secondary disabled={locked} onClick={()=>choose({kind:'recovery'})}>Replace recovery code</Button>
   </>}
  </section>
  <section className="security-card security-session-panel" id="security-sessions" tabIndex={-1} aria-label="Signed-in sessions">
   <div className="security-section-heading"><div><span className="security-symbol"><Icon name="clock" size={25}/></span><h2>Signed-in sessions</h2><p>Review where your Eupova account is signed in.</p></div><Button secondary disabled={locked} onClick={load}>{loading?'Refreshing…':'Refresh sessions'}</Button></div>
   {!data?<p role="status">{loading?'Loading sessions…':'Refresh to load your sessions.'}</p>:<>
    <div className="security-sessions">{sessions.length?sessions.map(s=><article key={s.id} className={s.current?'security-session security-session--current':'security-session'} aria-label={s.label}><div className="security-session-title"><h3>{s.label}</h3>{s.current&&<span className="security-badge">This session</span>}</div><dl><div><dt>Signed in</dt><dd>{date(s.createdAt)}</dd></div><div><dt>Last active</dt><dd>{date(s.lastSeenAt)}</dd></div></dl>{!s.current&&<Button secondary disabled={locked} onClick={()=>choose({kind:'session',id:s.id,label:s.label})}>Sign out this session</Button>}</article>):<p>No active sessions were returned. Refresh to check again.</p>}</div>
    <div className="security-session-footer"><p>{sessions.some(s=>!s.current)?'Your current session stays signed in when you remove other sessions.':'There are no other sessions to sign out.'}</p><Button secondary disabled={locked||!sessions.some(s=>!s.current)} onClick={()=>choose({kind:'others'})}>Sign out other sessions</Button></div>
    <details className="security-disclosure"><summary>About sessions and timestamps</summary><p>Browser labels are reported by the browser and may be approximate. Sessions end after two hours without activity or twelve hours from sign-in. Times are shown in UK time.</p></details>
   </>}
  </section>
  {pending&&<section className="security-card security-confirm" ref={confirmRef} tabIndex={-1} aria-label="Confirm security change"><h2>{pending.kind==='recovery'?'Replace your recovery code':pending.kind==='others'?'Sign out every other session':'Sign out '+pending.label}</h2><Notice>{pending.kind==='recovery'?'Your old recovery code will stop working immediately. Save the new code before leaving this screen. Your password and signed-in sessions will stay unchanged.':pending.kind==='others'?'Every other session’s access will be revoked. This session stays signed in. Old screens may remain visible until the next request.':'The selected session’s access will be revoked. This session stays signed in. Its old screen may remain visible until the next request.'}</Notice><form onSubmit={e=>{e.preventDefault();run(pending.kind==='recovery'?'rotateRecovery':'revokeSession',{currentPassword:password,...pending.kind==='others'?{allOthers:true}:pending.kind==='session'?{id:pending.id}:{}});}}><AccessPassword key={pending.kind+(pending.id??'')} id="security-confirm-password" label="Current password to confirm" autoComplete="current-password" required disabled={locked} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/><div className="security-actions"><Button disabled={locked||!password}>{busy?'Checking…':pending.kind==='recovery'?'Replace recovery code':pending.kind==='others'?'Sign out other sessions':'Sign out selected session'}</Button><Button type="button" secondary disabled={busy} onClick={()=>choose(null)}>Cancel</Button></div></form></section>}
  {data&&<section className="security-card security-history" aria-label="Security activity"><details className="security-disclosure"><summary>Recent security activity</summary>{data.events.length?<ul>{data.events.map((e,i)=><li key={i}><strong>{eventNames[e.event]??'Account security updated'}</strong><span>{date(e.at)} (UK time)</span></li>)}</ul>:<p>No recent security activity to show.</p>}</details><p className="security-meta">Wallet changes require your current password. Existing funding requests keep their original receiving address.</p></section>}
 </div>;
}
