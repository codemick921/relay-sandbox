import {Brand} from './Brand.jsx';
import AccessArtwork,{AccessRibbon} from './AccessArtwork';
import AccessPassword from './AccessPassword';
import './access.css';
import {FundingIntroduction} from './FundingHome';
import AccountSecurity from './AccountSecurity';
import AccountEmail from './AccountEmail';
import {resumeTarget} from './payment-resume.mjs';
import React,{useState,useEffect,useCallback} from 'react';
import App from './App';
import {api} from './api';
import {Button,Field,Notice,Check} from './ui';
export default function Access(){
 const [hasResume,setHasResume]=useState(()=>!!resumeTarget(window.location));
 const [access,setAccess]=useState(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[mode,setMode]=useState(()=>resumeTarget(window.location)?'signin':'welcome');
 const [inviteCode,setInviteCode]=useState('');
 const [email,setEmail]=useState(''),[name,setName]=useState(''),[password,setPassword]=useState(''),[currentPassword,setCurrentPassword]=useState(''),[code,setCode]=useState(''),[accepted,setAccepted]=useState(false),[recovery,setRecovery]=useState(''),[saved,setSaved]=useState(false),[link,setLink]=useState(null);
 const emailChanged=useCallback(verified=>setAccess(a=>a?.account&&a.account.emailVerified!==verified?{...a,account:{...a.account,emailVerified:verified}}:a),[]);
 const clearSecrets=()=>{setInviteCode('');setPassword('');setCurrentPassword('');setCode('');setRecovery('');setSaved(false);};
 const switchMode=next=>{clearSecrets();setError('');setMessage('');setAccepted(false);setMode(next);};
 function openLink(value){
  const match=/^#(verify-email|reset-password)=([a-f0-9]{64})$/.exec(value);
  if(!match)return;
  clearSecrets();setError('');setMessage('');setLink({purpose:match[1],token:match[2]});setMode(match[1]==='reset-password'?'reset':'confirmEmail');
 }
 useEffect(()=>{
  let active=true;
  const readLink=()=>{const resume=!!resumeTarget(window.location);setHasResume(resume);if(resume)setMode(current=>current==='welcome'?'signin':current);const hash=window.location.hash;if(hash.startsWith('#verify-email=')||hash.startsWith('#reset-password=')){window.history.replaceState(null,'',window.location.pathname+window.location.search);openLink(hash);}};
  readLink();window.addEventListener('hashchange',readLink);
  api('access').then(a=>active&&setAccess(a)).catch(e=>{if(!active)return;if(e.status===404)setAccess({hostedSandbox:false,authenticated:true});else setError('Eupova is temporarily unavailable. Please try again.');});
  const expired=()=>{clearSecrets();setHasResume(!!resumeTarget(window.location));setMode('signin');setAccess(previous=>({...previous,hostedSandbox:true,authenticated:false,account:null}));};window.addEventListener('relay-session-expired',expired);
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
   const result=await api(route,{email,name,password,currentPassword,code,recoveryCode:code,acceptSandbox:accepted,...selected==='signup'?{inviteCode:inviteCode.trim()}:{} ,linkToken:selected==='reset'?link?.token:undefined});
   clearSecrets();setAccess({...access,...result,account:result.account??null,recoveryCode:undefined});
   if(['reset','recover','security'].includes(selected))setLink(null);
   if(result.recoveryCode){setRecovery(result.recoveryCode);setSaved(false);}else setMode(link?.purpose==='verify-email'?'confirmEmail':'signin');
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function signout(preserveVerification=false){try{await api('logout',{});clearSecrets();setHasResume(!!resumeTarget(window.location));if(!(preserveVerification===true&&link?.purpose==='verify-email'))setLink(null);setMode('signin');setAccess({...access,authenticated:false,account:null});setError('');setMessage('');}catch{setError('Sign-out could not be confirmed. Please retry.');}}
 if(access?.authenticated&&!recovery&&!['security','confirmEmail','reset','forgot'].includes(mode))return <>{access.hostedSandbox&&<div className="sandbox-access-bar"><span>{access.account?`${access.account.name} · Your agent wallet account`:access.adminPaymentHealth?'Admin workspace · saved payment evidence':'Private tracking sandbox · simulated payments'}</span>{access.account&&<button onClick={()=>switchMode('security')}>{access.account.emailVerified?'Account security':'Account security · email unverified'}</button>}<button onClick={signout}>Sign out</button>{error&&<span role="alert">{error}</span>}</div>}<App/></>;
 if(access&&!access.authenticated&&access.customerAccounts&&!recovery&&!link&&!hasResume&&mode==='welcome')return <FundingIntroduction previewMode={!!access.localEmailPreview && !!access.previewMode} onFund={()=>switchMode('signup')} onSignIn={()=>switchMode('signin')}/>;
 const customer=access?.customerAccounts,effectiveMode=customer?mode:'tester';
 const emailEnabled=access?.emailSendingEnabled,localEmail=access?.localEmailPreview;
 const title={security:'Account security',signup:'Create your Eupova account',recover:'Use your recovery code',forgot:'Reset your password',reset:'Choose a new password',confirmEmail:'Verify your email'}[mode]??'Welcome to Eupova';
 const securing=mode==='security'&&!recovery;
 const verifying=mode==='confirmEmail'&&!recovery;
 const illustrated=!!access&&!access.authenticated&&!recovery&&!link&&!hasResume&&['signin','signup','tester'].includes(mode);
 return <main className={`sandbox-login auth-page ${illustrated?'auth-page--illustrated':'auth-page--compact'} ${verifying?'auth-page--verification':''} ${securing?'auth-page--security':''}`}><div className="auth-shell">
 {illustrated&&<AccessArtwork/>}
 <section className="panel auth-panel" aria-labelledby="auth-title"><div className="auth-panel-top"><Brand/>{securing&&<Button secondary disabled={busy} onClick={()=>{setLink(null);switchMode('signin');}}>Back to my wallets</Button>}{verifying&&<span className="auth-verification-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg></span>}{illustrated&&<AccessRibbon className="auth-mobile-ribbon"/>}</div><h1 id="auth-title">{recovery?'Save your recovery code':title}</h1><p>{securing?'Manage access to your Eupova account. Recovering this account does not recover access to an external wallet.':verifying?(access?.account?'Check that you’re signed in to the account this link was sent to.':'Sign in to the account this link was sent to. Then confirm your email address.'):'Save your agent wallets and track your funding. Review the payment mode before creating a checkout.'}</p>
 {hasResume&&!access?.authenticated&&<Notice>Sign in to the same Eupova account to resume your saved request. Opening this link does not create an order or send money.</Notice>}
 {error&&<Notice error>{error}</Notice>}{message&&<Notice>{message}</Notice>}
 {localEmail&&<Notice>Local email preview: messages stay in this test app. Nothing is sent to an inbox.</Notice>}
 {!access?<><p>Opening your workspace…</p>{error&&<Button onClick={()=>location.reload()}>Retry</Button>}</>:recovery?<>
  <Notice>This code replaces any earlier recovery code. Save it in your password manager before continuing. Anyone with it and your email can reset your password.</Notice>
  <Field label="Recovery code"><textarea className="mono recovery-code" readOnly value={recovery} rows={3} onFocus={e=>e.target.select()}/></Field>
  <p className="fine-print">Keep this code even after verifying your email. It gives you another way to recover access.</p>
  <Check checked={saved} onChange={e=>setSaved(e.target.checked)}>I have saved my recovery code.</Check>
  <Button className="full" disabled={!saved||busy} onClick={async()=>{if(access.authenticated&&!await action('confirmRecovery',{recoveryCode:recovery}))return;setRecovery('');setSaved(false);setMode(access.authenticated?'security':'signin');}}>{access.authenticated?'Continue to account security':'Return to sign in'}</Button>
 </>:mode==='confirmEmail'?<>
  {access.account&&<div className="auth-verification-account"><span>Signed in as</span><strong>{access.account.email}</strong></div>}
  <div className="auth-verification-actions">
   {access.account?<Button className="full" disabled={busy||!link} onClick={async()=>{const result=await action('verifyEmail',{linkToken:link?.token});if(result){setLink(null);setMode('security');}}}>{busy?'Confirming…':'Confirm email address'}</Button>:<Button className="full" onClick={()=>setMode('signin')}>Sign in to confirm</Button>}
   <div className="auth-verification-secondary" role="group" aria-label="Other options">
    {access.account&&<button type="button" className="text-button" disabled={busy} onClick={()=>signout(true)}>Sign in to a different account</button>}
    <button type="button" className="text-button" disabled={busy} onClick={()=>{setLink(null);switchMode(access.account?'security':'signin');}}>Cancel</button>
   </div>
  </div>
  <span className="auth-verification-status" role="status">{busy?'Confirming your email address…':''}</span>
  <p className="auth-verification-next">After confirmation, you’ll return to Account security.</p>
 </>:<>
 {customer&&!access.authenticated&&mode!=='reset'&&<nav className="auth-tabs" aria-label="Account access"><button type="button" disabled={busy} aria-pressed={mode==='signin'} onClick={()=>switchMode('signin')}>Sign in</button><button type="button" disabled={busy} aria-pressed={mode==='signup'} onClick={()=>switchMode('signup')}>Create account</button></nav>}
 {securing&&<nav className="security-jump" aria-label="Security sections">{[['email','Email'],['recovery','Recovery code'],['sessions','Sessions'],['password','Password']].map(([id,label])=><button type="button" key={id} onClick={()=>{const target=document.getElementById('security-'+id);target?.scrollIntoView({behavior:'instant',block:'start'});target?.focus();}}>{label}</button>)}</nav>}
 {mode==='security'&&<div className="security-dashboard">
  <AccountEmail account={access.account} onVerified={emailChanged} openLink={openLink}/>
  <AccountSecurity key={String(access.account.emailVerified)} onRecovery={value=>{setRecovery(value);setSaved(false);setError('');}}/>
 </div>}
 <form className={securing?'security-card security-password-form':undefined} id={securing?'security-password':undefined} tabIndex={securing?-1:undefined} aria-label={securing?'Change password':undefined} onSubmit={submit}>
 {securing&&<><h2>Change password</h2><p>Use a unique password for your Eupova account.</p></>}
 {effectiveMode==='tester'?<Field label="Tester access code" hint="Existing tester workspaces stay separate from customer accounts."><input type="password" autoComplete="current-password" required value={code} onChange={e=>setCode(e.target.value)}/></Field>:<>
 {mode==='signup'&&<Field label="Your name"><input id="auth-name" name="name" autoComplete="name" required minLength={2} maxLength={60} value={name} onChange={e=>setName(e.target.value)}/></Field>}
 {!['security','reset'].includes(mode)&&<Field label="Email address"><input id="auth-email" name="email" type="email" spellCheck="false" autoComplete="username" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)}/></Field>}
 {mode==='security'&&<AccessPassword id="security-current-password" label="Current password" autoComplete="current-password" required disabled={busy} maxLength={128} value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/>}
 {mode==='recover'&&<Field label="Recovery code"><input autoComplete="off" type="password" required minLength={64} maxLength={64} value={code} onChange={e=>setCode(e.target.value.trim())}/></Field>}
 {mode!=='forgot'&&<AccessPassword disabled={busy} key={effectiveMode} id={mode==='signin'?'auth-password':'auth-new-password'} name="password" label={['recover','security','reset'].includes(mode)?'New password':'Password'} hint={mode==='signin'?undefined:'Use 15 to 128 characters. A password manager can generate one for you.'} autoComplete={mode==='signin'?'current-password':'new-password'} required minLength={mode==='signin'?1:15} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/>}
 {mode==='signup'&&<Field label="Invitation code (optional)" hint="Invited to test? Enter your code to start in simulation mode."><input autoComplete="off" spellCheck="false" maxLength={36} value={inviteCode} onChange={e=>setInviteCode(e.target.value)}/></Field>}
 {mode==='signup'&&<><p className="fine-print">{emailEnabled?'After signing up, save your recovery code and verify your email.':'Email sending is not connected yet. Save the recovery code shown after sign-up to protect your access.'}</p><Check required checked={accepted} onChange={e=>setAccepted(e.target.checked)}>I understand that saving a wallet does not verify ownership. I must review each checkout before making a payment.</Check></>}
 {mode==='forgot'&&<Notice>{emailEnabled?(localEmail?'Test password recovery is available after test verification. View reset previews from Account security while signed in. If you cannot sign in, use your saved recovery code.':'Email recovery is available for accounts with a verified email address. If you have not verified yours, use your saved recovery code.'):'Email sending is not connected yet. You can reset your password using your saved recovery code.'}</Notice>}
 {mode==='recover'&&<Notice>Use your saved recovery code. Recovery signs you out on every device.</Notice>}
 {mode==='reset'&&<Notice>Choose a new password. This signs out every existing session and gives you a new recovery code. Your wallets stay saved.</Notice>}
 {mode==='security'&&<Notice>Changing your password signs out other sessions and gives you a new recovery code. Your wallets stay saved.</Notice>}
 </>}
 <Button className="full" disabled={busy||(mode==='forgot'&&!emailEnabled)||(mode==='reset'&&!link)}>{busy?'Please wait…':({tester:'Open tester workspace',signin:'Sign in',signup:'Create account',recover:'Reset password',security:'Change password',forgot:localEmail?'Create reset preview':'Request reset email',reset:'Save new password'})[effectiveMode]}</Button>
 </form>
 {customer&&!securing&&<div className="auth-links">{access.authenticated?<button type="button" className="text-button" disabled={busy} onClick={()=>{setLink(null);switchMode('signin');}}>Back to my wallets</button>:<><button type="button" className="text-button" disabled={busy} onClick={()=>switchMode(mode==='forgot'?'recover':'forgot')}>{mode==='forgot'?'Use a recovery code':'Forgot your password?'}</button><button type="button" className="text-button" disabled={busy} onClick={()=>{setLink(null);switchMode(mode==='tester'?'signin':'tester');}}>{mode==='tester'?'Use customer sign-in':'Existing tester access'}</button></>}</div>}
 </>}
 {!access?.authenticated&&!hasResume&&!link&&!recovery&&access?.customerAccounts&&<button type="button" className="text-button funding-auth-back" disabled={busy} onClick={()=>switchMode('welcome')}>Back to Eupova</button>}
 </section></div></main>;
}
