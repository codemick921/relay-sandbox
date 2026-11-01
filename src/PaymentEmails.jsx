import React,{useState,useEffect,useRef} from 'react';
import {Button,Check,Icon,Notice} from './ui';
import {api} from './api';
import './payment-emails.css';

export default function PaymentEmails({sampleEnabled=false,onPayment}){
 const [choices,setChoices]=useState({arrival:false,attention:false}),[saved,setSaved]=useState({arrival:false,attention:false}),[kind,setKind]=useState('arrival'),[message,setMessage]=useState(null),[format,setFormat]=useState('html'),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[session,setSession]=useState(null),[error,setError]=useState('');
 useEffect(()=>{if(!sampleEnabled)return;let active=true;api('payment-email-preview').then(data=>{if(active)setSession(data.session);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[sampleEnabled]);
 const previewHeading=useRef(null);
 useEffect(()=>{if(!message)return;previewHeading.current?.focus({preventScroll:true});if(window.matchMedia('(max-width:1050px)').matches)previewHeading.current?.scrollIntoView({block:'start'});},[message]);
 const dirty=Object.keys(choices).some(k=>choices[k]!==saved[k]);
 async function save(){setBusy(true);setError('');try{await api('payment-email-preview/preferences',{session,preferences:choices});setSaved({...choices});setStatus('Sample choices saved for this preview. Sending stays disabled.');}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function preview(){setBusy(true);setError('');try{const data=await api('payment-email-preview/event',{session,kind});setMessage(data.message);setStatus(data.message?'Sample email prepared. Nothing was sent.':data.reason);}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="payment-emails" aria-label="Payment email updates">
  <div className="email-intro"><div><h2>Payment email previews</h2><p>Preview sample messages for wallet arrivals and requests that need attention.</p></div><span className="email-disabled"><Icon name="info" size={17}/>Sending disabled</span></div>
  <Notice>{sampleEnabled?'Try both email types using sample events. Your real account preferences stay unchanged.':'Payment emails are not available yet. Your updates remain in the Eupova inbox.'}</Notice>
  {error&&<Notice error>{error}</Notice>}
  {sampleEnabled&&<div className="email-layout">
   <div className="email-controls"><section className="email-options"><h3>Choose your emails</h3><p className="email-muted">Both are optional and start switched off.</p>
    <div className="updates-preferences">{[['arrival','Funds arrived','When Eupova verifies USDC delivery to your saved wallet.'],['attention','Request needs attention','When payment details need review, a part payment is recorded, or a dispute or uncertain checkout needs checking.']].map(([key,label,hint])=><Check key={key} checked={choices[key]} disabled={busy} onChange={e=>{setChoices({...choices,[key]:e.target.checked});setStatus('');}}><strong>{label}</strong><small>{hint}</small></Check>)}</div>
    <Button disabled={busy||!session||!dirty} onClick={save}>Save sample choices</Button><p className="email-muted">These choices reset when you reload this preview.</p>
   </section><section className="email-try"><h3>Try a sample event</h3><div className="email-event-buttons" role="group" aria-label="Sample event type">{[['arrival','Funds arrived'],['attention','Needs attention']].map(([key,label])=><Button key={key} secondary aria-pressed={kind===key} disabled={busy} onClick={()=>{setKind(key);setStatus('');}}>{label}</Button>)}</div><Button secondary disabled={busy||!session||dirty} onClick={preview}>Preview sample email</Button><p className="email-muted">Save your choices first. Repeating the same event will not prepare a second email.</p><p className="email-status" role="status">{status}</p></section>
   <details className="email-rules"><summary>When an email would be prepared</summary><p>Only new updates after you opt in. No reminder for a routine tracking delay, no backlog of older payments, and no arrival message based only on Peer’s payment status.</p><p>You can switch either email type off. Turning it off prevents new messages of that type.</p></details>
   </div>
   <section className="email-preview" aria-label="Sample email preview"><div className="email-preview-head"><h3 ref={previewHeading} tabIndex={-1}>Email preview</h3><span>Sample recipient</span></div><p className="email-recipient">sample@example.test</p>
    {message?<><p className="email-subject"><strong>Subject</strong>{message.subject}</p><div className="email-formats" role="group" aria-label="Email preview format"><button type="button" aria-pressed={format==='html'} onClick={()=>setFormat('html')}>Designed email</button><button type="button" aria-pressed={format==='text'} onClick={()=>setFormat('text')}>Plain text</button></div>{format==='html'?<iframe title="Designed sample email" sandbox="" srcDoc={message.html}/>:<pre className="email-plain">{message.text}</pre>}<Button secondary onClick={()=>onPayment(message.requestId)}>View sample payment</Button><p className="email-muted">The email’s link is inactive in this preview. Use the button above to open its sample payment.</p></>:<div className="email-preview-empty"><span><Icon name="activity" size={32}/></span><h3>Preview a sample email</h3><p>Save a sample email choice, then preview its event.</p></div>}
   </section>
  </div>}

 </section>;
}
