import AccountSecurity from './AccountSecurity';
import {resumeTarget} from './payment-resume.mjs';
import React,{useState,useEffect} from 'react';
import App from './App';
import {api} from './api';
import {Button,Field,Notice,Check} from './ui';
export default function Access(){
 const [hasResume,setHasResume]=useState(()=>!!resumeTarget(window.location));
 const [access,setAccess]=useState(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[mode,setMode]=useState('signin');
 const [email,setEmail]=useState(''),[name,setName]=useState(''),[password,setPassword]=useState(''),[currentPassword,setCurrentPassword]=useState(''),[code,setCode]=useState(''),[accepted,setAccepted]=useState(false),[recovery,setRecovery]=useState(''),[saved,setSaved]=useState(false),[link,setLink]=useState(null),[emails,setEmails]=useState([]);
 const clearSecrets=()=>{setPassword('');setCurrentPassword('');setCode('');setRecovery('');setSaved(false);setEmails([]);};
 const switchMode=next=>{clearSecrets();setError('');setMessage('');setAccepted(false);setMode(next);};
 function openLink(value){
  const match=/^#(verify-email|reset-password)=([a-f0-9]{64})$/.exec(value);
  if(!match)return;
  clearSecrets();setError('');setMessage('');setLink({purpose:match[1],token:match[2]});setMode(match[1]==='reset-password'?'reset':'confirmEmail');
 }
 useEffect(()=>{
  let active=true;
  const readLink=()=>{setHasResume(!!resumeTarget(window.location));const hash=window.location.hash;if(hash.startsWith('#verify-email=')||hash.startsWith('#reset-password=')){window.history.replaceState(null,'',window.location.pathname+window.location.search);openLink(hash);}};
  readLink();window.addEventListener('hashchange',readLink);
  api('access').then(a=>active&&setAccess(a)).catch(e=>{if(!active)return;if(e.status===404)setAccess({hostedSandbox:false,authenticated:true});else setError('Relay is temporarily unavailable. Please try again.');});
  const expired=()=>{clearSecrets();setMode('signin');setAccess(previous=>({...previous,hostedSandbox:true,authenticated:false,account:null}));};window.addEventListener('relay-session-expired',expired);
  return()=>{active=false;window.removeEventListener('hashchange',readLink);window.removeEventListener('relay-session-expired',expired);};
 },[]);
 async function action(route,data={}){
  setBusy(true);setError('');setMessage('');
  try{const result=await api('account/'+route,data);if(result.account)setAccess(a=>({...a,account:result.account}));if(result.message)setMessage(result.message);return result;}catch(e){setError(e.message);return null;}finally{setBusy(false);}
 }
 async function submit(e){
  e.preventDefault();setBusy(true);setError('');setMessage('');
  try{
   const selected=access?.customerAccounts?mode:'tester';
   if(selected==='forgot'){
    const result=await api('account/requestReset',{email});setMessage(result.message);return;
   }
   const route=selected==='tester'?'login':`account/${({signin:'login',signup:'signup',recover:'recover',security:'password',reset:'resetPassword'})[selected]}`;
   const result=await api(route,{email,name,password,currentPassword,code,recoveryCode:code,acceptSandbox:accepted,linkToken:selected==='reset'?link?.token:undefined});
   clearSecrets();setAccess({...access,...result,account:result.account??null,recoveryCode:undefined});
   if(['reset','recover','security'].includes(selected))setLink(null);
   if(result.recoveryCode){setRecovery(result.recoveryCode);setSaved(false);}else setMode(link?.purpose==='verify-email'?'confirmEmail':'signin');
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function signout(){try{await api('logout',{});clearSecrets();setLink(null);setMode('signin');setAccess({...access,authenticated:false,account:null});setError('');setMessage('');}catch{setError('Sign-out could not be confirmed. Please retry.');}}
 if(access?.authenticated&&!recovery&&!['security','confirmEmail','reset','forgot'].includes(mode))return <>{access.hostedSandbox&&<div className="sandbox-access-bar"><span>{access.account?`${access.account.name} · Your agent wallet account`:'Private tracking sandbox · simulated payments'}</span>{access.account&&<button onClick={()=>switchMode('security')}>{access.account.emailVerified?'Account security':'Account security · email unverified'}</button>}<button onClick={signout}>Sign out</button>{error&&<span role="alert">{error}</span>}</div>}<App/></>;
 const customer=access?.customerAccounts,effectiveMode=customer?mode:'tester';
 const emailEnabled=access?.emailSendingEnabled,localEmail=access?.localEmailPreview;
 const title={security:'Account security',signup:'Create your Relay account',recover:'Use your recovery code',forgot:'Reset your password',reset:'Choose a new password',confirmEmail:'Verify your email'}[mode]??'Welcome to Relay';
 return <main className="sandbox-login"><section className="panel"><span className="brand-mark">R</span><h1>{recovery?'Save your recovery code':title}</h1><p>Save your agent wallets and track your funding. Review the payment mode before creating a checkout.</p>
 {hasResume&&!access?.authenticated&&<Notice>Sign in to the same Relay account to resume your saved request. Opening this link does not create an order or send money.</Notice>}
 {error&&<Notice error>{error}</Notice>}{message&&<Notice>{message}</Notice>}
 {localEmail&&<Notice>Local email preview: messages stay in this test app. Nothing is sent to an inbox.</Notice>}
 {!access?<><p>Opening your workspace…</p>{error&&<Button onClick={()=>location.reload()}>Retry</Button>}</>:recovery?<>
  <Notice>This code replaces any earlier recovery code. Save it in your password manager before continuing. Anyone with it and your email can reset your password.</Notice>
  <Field label="Recovery code"><textarea className="mono recovery-code" readOnly value={recovery} rows={3} onFocus={e=>e.target.select()}/></Field>
  <p className="fine-print">Keep this code even after verifying your email. It gives you another way to recover access.</p>
  <Check checked={saved} onChange={e=>setSaved(e.target.checked)}>I have saved my recovery code.</Check>
  <Button className="full" disabled={!saved||busy} onClick={async()=>{if(access.authenticated&&!await action('confirmRecovery',{recoveryCode:recovery}))return;setRecovery('');setSaved(false);setMode(access.authenticated?'security':'signin');}}>{access.authenticated?'Continue to account security':'Return to sign in'}</Button>
 </>:mode==='confirmEmail'?<>
  <p>{access.account?`Confirm the email address for ${access.account.email}.`:'Sign in to the account this link was sent to. Then confirm your email address.'}</p>
  {access.account?<><Button disabled={busy||!link} onClick={async()=>{const result=await action('verifyEmail',{linkToken:link?.token});if(result){setLink(null);setMode('security');}}}>Confirm email address</Button><button className="text-button" disabled={busy} onClick={signout}>Sign in to a different account</button></>:<Button onClick={()=>setMode('signin')}>Sign in to confirm</Button>}
  <button className="text-button" onClick={()=>{setLink(null);switchMode(access.account?'security':'signin');}}>Cancel</button>
 </>:<>
 {customer&&!access.authenticated&&mode!=='reset'&&<nav className="auth-tabs" aria-label="Account access"><button type="button" disabled={busy} aria-pressed={mode==='signin'} onClick={()=>switchMode('signin')}>Sign in</button><button type="button" disabled={busy} aria-pressed={mode==='signup'} onClick={()=>switchMode('signup')}>Create account</button></nav>}
 {mode==='security'&&<section aria-label="Email verification">
  <h2>Email address</h2><p>{access.account?.email}</p>
  <Notice>{access.account?.emailVerified?(localEmail?'Test verification complete. This local preview does not prove access to an inbox or ownership of a wallet.':'Email verified. This confirms access to your email address; it does not verify wallet ownership.'):emailEnabled?'Verify your email to use email-based password recovery. Your saved wallets stay available.':'Email sending is not connected yet. Your account and saved wallets work; keep your recovery code for password recovery.'}</Notice>
  {!access.account?.emailVerified&&<Button disabled={busy||!emailEnabled} onClick={()=>action('requestVerification')}>{localEmail?'Create verification preview':'Send verification email'}</Button>}
  {localEmail&&<><Button disabled={busy||!access.account?.emailVerified} onClick={()=>action('requestReset',{email:access.account.email})}>Create password reset preview</Button><Button disabled={busy} onClick={async()=>{const result=await action('emailPreview');if(result)setEmails(result.emails);}}>View local test emails</Button>
  {emails.length>0?<div aria-label="Local test mailbox">{emails.map(m=><article key={m.id}><h3>{m.subject}</h3><p className="fine-print">Test message only. No email was sent.</p>{m.purpose!=='changed'&&<a href={m.link} onClick={e=>{e.preventDefault();openLink(new URL(m.link).hash);}}>Open this test link</a>}</article>)}</div>:<p className="fine-print">New previews may take a few seconds. Use “View local test emails” to check.</p>}</>}
  <AccountSecurity onRecovery={value=>{setRecovery(value);setSaved(false);setError('');}}/><h2>Change password</h2>
 </section>}
 <form onSubmit={submit}>
 {effectiveMode==='tester'?<Field label="Tester access code" hint="Existing tester workspaces stay separate from customer accounts."><input type="password" autoComplete="current-password" required value={code} onChange={e=>setCode(e.target.value)}/></Field>:<>
 {mode==='signup'&&<Field label="Your name"><input autoComplete="name" required minLength={2} maxLength={60} value={name} onChange={e=>setName(e.target.value)}/></Field>}
 {!['security','reset'].includes(mode)&&<Field label="Email address"><input type="email" autoComplete="username" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)}/></Field>}
 {mode==='security'&&<Field label="Current password"><input type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></Field>}
 {mode==='recover'&&<Field label="Recovery code"><input autoComplete="off" type="password" required minLength={64} maxLength={64} value={code} onChange={e=>setCode(e.target.value.trim())}/></Field>}
 {mode!=='forgot'&&<Field label={['recover','security','reset'].includes(mode)?'New password':'Password'} hint={mode==='signin'?undefined:'Use 15 to 128 characters. A password manager can generate one for you.'}><input type="password" autoComplete={mode==='signin'?'current-password':'new-password'} required minLength={mode==='signin'?1:15} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></Field>}
 {mode==='signup'&&<><p className="fine-print">{emailEnabled?'After signing up, save your recovery code and verify your email.':'Email sending is not connected yet. Save the recovery code shown after sign-up to protect your access.'}</p><Check required checked={accepted} onChange={e=>setAccepted(e.target.checked)}>I understand that saving a wallet does not verify ownership. I must review each checkout before making a payment.</Check></>}
 {mode==='forgot'&&<Notice>{emailEnabled?(localEmail?'Test password recovery is available after test verification. View reset previews from Account security while signed in. If you cannot sign in, use your saved recovery code.':'Email recovery is available for accounts with a verified email address. If you have not verified yours, use your saved recovery code.'):'Email sending is not connected yet. You can reset your password using your saved recovery code.'}</Notice>}
 {mode==='recover'&&<Notice>Use your saved recovery code. Recovery signs you out on every device.</Notice>}
 {mode==='reset'&&<Notice>Choose a new password. This signs out every existing session and gives you a new recovery code. Your wallets stay saved.</Notice>}
 {mode==='security'&&<Notice>Changing your password signs out other sessions and gives you a new recovery code. Your wallets stay saved.</Notice>}
 </>}
 <Button className="full" disabled={busy||(mode==='forgot'&&!emailEnabled)||(mode==='reset'&&!link)}>{busy?'Please wait…':({tester:'Open tester workspace',signin:'Sign in',signup:'Create account',recover:'Reset password',security:'Change password',forgot:localEmail?'Create reset preview':'Request reset email',reset:'Save new password'})[effectiveMode]}</Button>
 </form>
 {customer&&<div className="auth-links">{access.authenticated?<button type="button" className="text-button" disabled={busy} onClick={()=>{setLink(null);switchMode('signin');}}>Back to my wallets</button>:<><button type="button" className="text-button" disabled={busy} onClick={()=>switchMode(mode==='forgot'?'recover':'forgot')}>{mode==='forgot'?'Use a recovery code':'Forgot your password?'}</button><button type="button" className="text-button" disabled={busy} onClick={()=>{setLink(null);switchMode(mode==='tester'?'signin':'tester');}}>{mode==='tester'?'Use customer sign-in':'Existing tester access'}</button></>}</div>}
 </>}
 </section></main>;
}
