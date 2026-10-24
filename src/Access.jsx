import React,{useState,useEffect} from 'react';
import App from './App';
import {api} from './api';
import {Button,Field,Notice,Check} from './ui';
export default function Access(){
 const [access,setAccess]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[mode,setMode]=useState('signin');
 const [email,setEmail]=useState(''),[name,setName]=useState(''),[password,setPassword]=useState(''),[currentPassword,setCurrentPassword]=useState(''),[code,setCode]=useState(''),[accepted,setAccepted]=useState(false),[recovery,setRecovery]=useState(''),[saved,setSaved]=useState(false);
 const clearSecrets=()=>{setPassword('');setCurrentPassword('');setCode('');setRecovery('');setSaved(false);};
 const switchMode=next=>{clearSecrets();setError('');setAccepted(false);setMode(next);};
 useEffect(()=>{let active=true;api('access').then(a=>active&&setAccess(a)).catch(e=>{if(!active)return;if(e.status===404)setAccess({hostedSandbox:false,authenticated:true});else setError('Relay is temporarily unavailable. Please try again.');});const expired=()=>{clearSecrets();setMode('signin');setAccess(previous=>({...previous,hostedSandbox:true,authenticated:false,account:null}));};window.addEventListener('relay-session-expired',expired);return()=>{active=false;window.removeEventListener('relay-session-expired',expired);};},[]);
 async function submit(e){
  e.preventDefault();setBusy(true);setError('');
  try{
   const selected=access?.customerAccounts?mode:'tester';
   const route=selected==='tester'?'login':`account/${({signin:'login',signup:'signup',recover:'recover',security:'password'})[selected]}`;
   const result=await api(route,{email,name,password,currentPassword,code,recoveryCode:code,acceptSandbox:accepted});
   clearSecrets();setAccess({...access,...result,recoveryCode:undefined});
   if(result.recoveryCode){setRecovery(result.recoveryCode);setSaved(false);}else setMode('signin');
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 if(access?.authenticated&&!recovery&&mode!=='security')return <>{access.hostedSandbox&&<div className="sandbox-access-bar"><span>{access.account?`${access.account.name} · Payments disabled`:'Private tracking sandbox · simulated payments'}</span>{access.account&&<button onClick={()=>switchMode('security')}>Account security</button>}<button onClick={async()=>{try{await api('logout',{});clearSecrets();setMode('signin');setAccess({...access,authenticated:false,account:null});setError('');}catch{setError('Sign-out could not be confirmed. Please retry.');}}}>Sign out</button>{error&&<span role="alert">{error}</span>}</div>}<App/></>;
 const customer=access?.customerAccounts,effectiveMode=customer?mode:'tester';
 return <main className="sandbox-login"><section className="panel"><span className="brand-mark">R</span><h1>{recovery?'Save your recovery code':mode==='security'?'Account security':mode==='signup'?'Create your Relay account':mode==='recover'?'Recover your account':'Welcome to Relay'}</h1><p>Save your agent wallets. Real payments are disabled.</p>
 {error&&<Notice error>{error}</Notice>}
 {!access?<><p>Opening your workspace…</p>{error&&<Button onClick={()=>location.reload()}>Retry</Button>}</>:recovery?<>
  <Notice>This code replaces any earlier recovery code. Save it in your password manager before continuing. Anyone with it and your email can reset your password.</Notice>
  <Field label="Recovery code"><textarea className="mono recovery-code" readOnly value={recovery} rows={3} onFocus={e=>e.target.select()}/></Field>
  <p className="fine-print">Relay does not send recovery emails yet. If you lose this code and your password, you cannot recover access through this screen.</p>
  <Check checked={saved} onChange={e=>setSaved(e.target.checked)}>I have saved my recovery code.</Check>
  <Button className="full" disabled={!saved} onClick={()=>{setRecovery('');setSaved(false);setMode('signin');}}>{access.authenticated?'Continue to my wallets':'Return to sign in'}</Button>
 </>:<>
 {customer&&!access.authenticated&&<nav className="auth-tabs" aria-label="Account access"><button type="button" disabled={busy} aria-pressed={mode==='signin'} onClick={()=>switchMode('signin')}>Sign in</button><button type="button" disabled={busy} aria-pressed={mode==='signup'} onClick={()=>switchMode('signup')}>Create account</button></nav>}
 <form onSubmit={submit}>
 {effectiveMode==='tester'?<Field label="Tester access code" hint="Existing tester workspaces stay separate from customer accounts."><input type="password" autoComplete="current-password" required value={code} onChange={e=>setCode(e.target.value)}/></Field>:<>
 {mode==='signup'&&<Field label="Your name"><input autoComplete="name" required minLength={2} maxLength={60} value={name} onChange={e=>setName(e.target.value)}/></Field>}
 {mode!=='security'&&<Field label="Email address"><input type="email" autoComplete="username" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)}/></Field>}
 {mode==='security'&&<><p>{access.account?.email}</p><Field label="Current password"><input type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></Field></>}
 {mode==='recover'&&<Field label="Recovery code"><input autoComplete="off" type="password" required minLength={64} maxLength={64} value={code} onChange={e=>setCode(e.target.value.trim())}/></Field>}
 <Field label={['recover','security'].includes(mode)?'New password':'Password'} hint={mode==='signin'?undefined:'Use 15 to 128 characters. A password manager can generate one for you.'}><input type="password" autoComplete={mode==='signin'?'current-password':'new-password'} required minLength={mode==='signin'?1:15} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></Field>
 {mode==='signup'&&<><p className="fine-print">Your email is a sign-in name for now; Relay does not verify it or send emails. Save the recovery code shown after sign-up.</p><Check required checked={accepted} onChange={e=>setAccepted(e.target.checked)}>I understand that payments are disabled and saved wallet ownership is not verified.</Check></>}
 {mode==='recover'&&<Notice>Use the recovery code you saved when creating your account or changing your password. Recovery signs you out on every device.</Notice>}
 {mode==='security'&&<Notice>Changing your password signs out other sessions and gives you a new recovery code. Your wallets stay saved.</Notice>}
 </>}
 <Button className="full" disabled={busy}>{busy?'Please wait…':({tester:'Open tester workspace',signin:'Sign in',signup:'Create account',recover:'Reset password',security:'Change password'})[effectiveMode]}</Button>
 </form>
 {customer&&<div className="auth-links">{access.authenticated?<button type="button" className="text-button" disabled={busy} onClick={()=>switchMode('signin')}>Back to my wallets</button>:<><button type="button" className="text-button" disabled={busy} onClick={()=>switchMode('recover')}>Forgot your password?</button><button type="button" className="text-button" disabled={busy} onClick={()=>switchMode(mode==='tester'?'signin':'tester')}>{mode==='tester'?'Use customer sign-in':'Existing tester access'}</button></>}</div>}
 </>}
 </section></main>;
}
