import React,{useEffect,useState} from 'react';
import {api} from './api';
import {Button,Field,Notice} from './ui';
const date=v=>v?new Date(v).toLocaleString('en-GB'):'Not confirmed';
const eventNames={recovery_confirmed:'Recovery code confirmed',recovery_rotated:'Recovery code replaced',session_revoked:'A session was signed out',other_sessions_revoked:'Other sessions were signed out',wallet_added:'Receiving wallet saved',wallet_updated:'Receiving wallet updated'};
export default function AccountSecurity({onRecovery}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[password,setPassword]=useState(''),[code,setCode]=useState(''),[pending,setPending]=useState(null);
 const load=async()=>setData(await api('account/security',{}));
 useEffect(()=>{let active=true;api('account/security',{}).then(x=>active&&setData(x)).catch(e=>active&&setError(e.message));return()=>{active=false;};},[]);
 async function run(route,body){setBusy(true);setError('');setMessage('');try{const r=await api('account/'+route,body);setPassword('');setCode('');setPending(null);if(r.recoveryCode)onRecovery(r.recoveryCode);else{setMessage(r.message);await load();}}catch(e){setError(e.message);setPassword('');setCode('');}finally{setBusy(false);}}
 return <div className="account-security-tools">
  <h2>Recovery checklist</h2>
  <p>Protect access to Relay and your saved destinations. Relay cannot recover keys or funds in your external wallet.</p>
  {error&&<Notice error>{error}</Notice>}{message&&<p role="status">{message}</p>}
  {!data?<Button secondary disabled={busy} onClick={()=>load().catch(e=>setError(e.message))}>Load security details</Button>:<>
   <ul className="security-checklist">
    <li><strong>Recovery code</strong><span>{data.recoveryConfirmedAt?'Current code confirmed '+date(data.recoveryConfirmedAt):'Not confirmed. Check that you can retrieve your saved code.'}</span></li>
    <li><strong>Email recovery</strong><span>{data.emailRecoveryPreview?'Test recovery only. No email is sent.':data.emailRecoveryAvailable?'Available for your verified email.':data.emailVerification?.mode==='unavailable'?'Email sending is unavailable. Use your recovery code.':'Verify your email address to enable email recovery.'}</span></li>
    <li><strong>Wallet changes</strong><span>Your current password is required each time. Existing requests keep their original destination.</span></li>
   </ul>
   <details className="security-section"><summary>Confirm my saved recovery code</summary><p>Enter the latest code from your password manager. Relay checks it without replacing it.</p><form onSubmit={e=>{e.preventDefault();run('confirmRecovery',{recoveryCode:code});}}><Field label="Saved recovery code"><input required type="password" autoComplete="off" minLength={64} maxLength={64} value={code} onChange={e=>setCode(e.target.value.trim())}/></Field><Button secondary disabled={busy}>Confirm saved code</Button></form></details>
   <Button secondary disabled={busy} onClick={()=>{setPending({kind:'recovery'});setPassword('');setError('');}}>Replace recovery code</Button>
   <h2>Signed-in sessions</h2><Button secondary disabled={busy} onClick={()=>load().catch(e=>setError(e.message))}>Refresh sessions</Button><p>Browser labels are reported by the browser and may be approximate. Sessions end after two hours without activity or twelve hours from sign-in.</p>
   <div className="security-sessions">{data.sessions.map(s=><article key={s.id}><strong>{s.label}{s.current?' · This session':''}</strong><small>Signed in {date(s.createdAt)}<br/>Last active {date(s.lastSeenAt)}</small>{!s.current&&<Button secondary disabled={busy} onClick={()=>{setPending({kind:'session',id:s.id,label:s.label});setPassword('');setError('');}}>Sign out this session</Button>}</article>)}</div>
   <Button secondary disabled={busy||!data.sessions.some(s=>!s.current)} onClick={()=>{setPending({kind:'others'});setPassword('');setError('');}}>Sign out other sessions</Button>
   {pending&&<section className="security-confirm"><h3>{pending.kind==='recovery'?'Replace your recovery code':pending.kind==='others'?'Sign out every other session':'Sign out '+pending.label}</h3><Notice>{pending.kind==='recovery'?'Your old recovery code will stop working immediately. Save the new code before leaving this screen. Your password and signed-in sessions will stay unchanged.':pending.kind==='others'?'Every other session’s access will be revoked. This session stays signed in. Old screens may remain visible until the next request.':'The selected session’s access will be revoked. This session stays signed in. Its old screen may remain visible until the next request.'}</Notice><form onSubmit={e=>{e.preventDefault();run(pending.kind==='recovery'?'rotateRecovery':'revokeSession',{currentPassword:password,...pending.kind==='others'?{allOthers:true}:pending.kind==='session'?{id:pending.id}:{}});}}><Field label="Current password to confirm"><input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></Field><Button disabled={busy}>{busy?'Checking…':'Confirm'}</Button><Button type="button" secondary disabled={busy} onClick={()=>{setPending(null);setPassword('');}}>Cancel</Button></form></section>}
   {!!data.events.length&&<details className="security-section"><summary>Recent security activity</summary><ul>{data.events.map((e,i)=><li key={i}>{eventNames[e.event]??'Account security updated'} · {date(e.at)}</li>)}</ul></details>}
  </>}
 </div>;
}
