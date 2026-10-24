import React,{useState,useEffect} from 'react';
import App from './App';
import {api} from './api';
import {Button,Field,Notice} from './ui';
export default function Access(){
 const [access,setAccess]=useState(null),[error,setError]=useState(''),[code,setCode]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;api('access').then(a=>active&&setAccess(a)).catch(e=>{if(!active)return;if(e.status===404)setAccess({hostedSandbox:false,authenticated:true});else setError('Relay is temporarily unavailable. Please try again.');});const expired=()=>setAccess({hostedSandbox:true,authenticated:false});window.addEventListener('relay-session-expired',expired);return()=>{active=false;window.removeEventListener('relay-session-expired',expired);};},[]);
 if(access?.authenticated)return <>{access.hostedSandbox&&<div className="sandbox-access-bar"><span>Private hosted sandbox</span><button onClick={async()=>{try{await api('logout',{});setAccess({...access,authenticated:false});}catch{setError('Sign-out could not be confirmed. Please retry.');}}}>Sign out</button>{error&&<span role="alert">{error}</span>}</div>}<App/></>;
 return <main className="sandbox-login"><section className="panel"><span className="brand-mark">R</span><h1>Welcome to Relay</h1><p>Private sandbox · no real funds</p>{error&&<Notice error>{error}</Notice>}{!access?<><p>Opening your workspace…</p>{error&&<Button onClick={()=>location.reload()}>Retry</Button>}</>:<form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const a=await api('login',{code});setCode('');setAccess(a);}catch(e){setError(e.message);}finally{setBusy(false);}}}><Field label="Tester access code" hint="Use the private code supplied for your sandbox workspace."><input type="password" autoComplete="current-password" required value={code} onChange={e=>setCode(e.target.value)}/></Field><Button className="full" disabled={busy}>{busy?'Signing in…':'Open sandbox'}</Button></form>}</section></main>;
}
