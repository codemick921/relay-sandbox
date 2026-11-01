import React,{useEffect,useState} from 'react';
import {api} from './api';
import {Button,Notice,Icon} from './ui';
const date=value=>value?new Date(value).toLocaleString('en-GB',{timeZone:'Europe/London',timeZoneName:'short'}):'';
const descriptions={
 unavailable:'Email sending is not connected yet. Keep your recovery code safe; you can use it to reset your password.',
 not_requested:'Verify your email to use email-based password recovery.',
 queued:'Your verification email is queued. This screen will update when Eupova has checked its status.',
 sending:'Eupova is requesting your verification email. Delivery has not been confirmed.',
 accepted:'The email service accepted your verification message. Check your inbox and spam folder, then open the link to verify your address.',
 unknown:'Email delivery could not be confirmed. If a message arrives, you can use its link. You can also request a new one.',
 expired:'Your verification request or link has expired. Request a new email to continue.',
 superseded:'This verification link is no longer active. Request a new email to continue.',
 verified:'Email verified. This confirms access to your email address; it does not verify wallet ownership.'
};
export default function AccountEmail({account,onVerified,openLink}){
 const [state,setState]=useState(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[emails,setEmails]=useState([]),[retry,setRetry]=useState(0);
 useEffect(()=>{
  let active=true,pending=false;
  async function refresh(){if(pending||document.hidden)return;pending=true;try{const data=await api('account/security',{});if(active){setState(data.emailVerification);onVerified(data.emailVerification.verified);setError('');}}catch(e){if(active)setError(e.message);}finally{pending=false;}}
  refresh();const timer=setInterval(refresh,15000);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
 },[account.id,onVerified,retry]);
 async function run(route,body={}){
  setBusy(true);setError('');setMessage('');
  try{const result=await api('account/'+route,body);setMessage(result.message??'');if(result.emails)setEmails(result.emails);const data=await api('account/security',{});setState(data.emailVerification);onVerified(data.emailVerification.verified);}catch(e){setError(e.message);}finally{setBusy(false);}
 }
 const preview=state?.mode==='preview',canRequest=state&&state.mode!=='unavailable'&&!state.verified;
 return <section className="security-card security-email" id="security-email" tabIndex={-1} aria-label="Email verification">
  <div className="security-card-heading"><span className="security-symbol"><Icon name="info" size={25}/></span><h2>Email address</h2></div><p className="security-email-address">{account.email}</p>
  {error&&<Notice error>{error}</Notice>}{message&&<p role="status">{message}</p>}
  {!state?<><p>{error?'Email verification details are unavailable.':'Checking email verification…'}</p>{error&&<Button secondary onClick={()=>{setError('');setRetry(n=>n+1);}}>Retry email status</Button>}</>:<>
   <Notice>{preview?(state.verified?'Test verification complete. No inbox ownership has been verified.':state.status==='accepted'?'Your local verification preview is ready. Open it below to test the flow.':'Local email test. No message will be sent to an inbox.'):descriptions[state.status]}</Notice>
   {state.verifiedAt&&<p className="fine-print">{preview?'Test confirmed':'Verified'} {date(state.verifiedAt)}</p>}
   {state.verified&&state.mode==='unavailable'&&<Notice>Email sending is currently unavailable. Use your recovery code if you need to reset your password.</Notice>}
   {state.requestedAt&&!state.verified&&<p className="fine-print">Last request: {date(state.requestedAt)}{state.expiresAt?' · Link expires: '+date(state.expiresAt):''}</p>}
   {canRequest&&<Button disabled={busy||['queued','sending'].includes(state.status)} onClick={()=>run('requestVerification')}>{preview?'Create verification preview':state.status==='not_requested'?'Send verification email':'Request a new verification email'}</Button>}
   {canRequest&&!preview&&<p className="fine-print">Links expire after one hour and work once. Sign in to this account before confirming. A new link replaces earlier links when it is prepared.</p>}
   {preview&&<><Button disabled={busy||!state.verified} onClick={()=>run('requestReset',{email:account.email})}>Create password reset preview</Button><Button disabled={busy} onClick={()=>run('emailPreview')}>View local test emails</Button>
    {emails.length>0?<div aria-label="Local test mailbox">{emails.map(m=><article key={m.id}><h3>{m.subject}</h3><p className="fine-print">Test message only. No email was sent.</p>{m.purpose!=='changed'&&<a href={m.link} onClick={e=>{e.preventDefault();openLink(new URL(m.link).hash);}}>Open this test link</a>}</article>)}</div>:<p className="fine-print">New previews may take a few seconds. Use “View local test emails” to check.</p>}</>}
  </>}
 </section>;
}
