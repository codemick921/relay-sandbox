import React,{useEffect,useRef,useState} from 'react';
import {Button,Icon,Check} from './ui';
import {readBuyerConnectionStatus} from './buyer-connection.mjs';
import './buyer-connection.css';

const wording={
 disabled:['Connection paused','Token issuance is disabled. This screen cannot sign you in to Privy.'],
 ready:['Ready for a sample test','Try the connection steps with sample data.'],
 connecting:['Connecting sample account…','You can cancel while the sample connection is being checked.'],
 connected:['Sample connection active','The sample account has reached the connected state. No Privy session exists.'],
 error:['Sample connection failed','The sample service could not connect. Your Eupova account is unchanged.'],
 rejected:['Sample connection declined','The sample account could not be authorised. Review the test details before trying again.'],
 expired:['Sample session expired','Start a fresh sample connection to continue testing.'],
 disconnected:['Sample account disconnected','The sample connection has ended. You can try it again.'],
 unavailable:['Status unavailable','We could not confirm the test status. Connection remains unavailable.']
};
export function BuyerConnectionCard({state='disabled',sample=false,onConnect,onCancel,onDisconnect,onRefresh}){
 const [consent,setConsent]=useState(false),lastState=useRef(state);
 const effective=sample&&wording[state]?state:state==='unavailable'?'unavailable':'disabled';
 useEffect(()=>{if(lastState.current!==state){setConsent(false);lastState.current=state;}},[state]);
 const [title,description]=wording[effective],canTry=sample&&['ready','error','rejected','expired','disconnected'].includes(effective)&&typeof onConnect==='function';
 return <section className="security-card buyer-connection" aria-labelledby="buyer-connection-title">
  <header className="buyer-connection-heading"><div className="security-card-heading"><span className="security-symbol"><Icon name="convert" size={25}/></span><h2 id="buyer-connection-title">Privy connection test</h2></div><span className="buyer-connection-label">{sample?'Sample preview':'Development only'}</span></header>
  <div className="buyer-connection-grid"><div className="buyer-connection-explanation"><h3>Use your Eupova sign-in.</h3><p>We’re preparing a development test that uses your existing Eupova sign-in to authenticate with Privy.</p>
   <ol className="buyer-connection-route" aria-label="Connection test stages"><li><span><Icon name="check" size={18}/></span><div><strong>Eupova account</strong><small>{sample?'Sample account only':'Restricted development tester'}</small></div></li><li><span><Icon name="convert" size={18}/></span><div><strong>Privy connection</strong><small>{sample?'Simulated in this preview':'Paused while we prepare the test'}</small></div></li></ol>
   <details className="security-disclosure"><summary>What this test covers</summary><p>{sample?'This preview runs locally with sample states. It does not send an identity or sign-in token to Privy.':'This page checks whether your account has access to the development test. It does not send a sign-in token to Privy.'}</p><p>Wallet creation, payment signing and checkout are outside this test. Your saved receiving wallets stay separate.</p></details>
  </div><div className={'buyer-connection-status buyer-connection-status--'+effective}>
   <div className="buyer-connection-status-top"><span className="buyer-connection-dot" aria-hidden="true"/><span>{sample?'Sample status':'Connection status'}</span></div>
   <div role="status" aria-live="polite" aria-atomic="true"><h3>{title}</h3><p>{description}</p></div>
   {canTry&&<Check checked={consent} onChange={e=>setConsent(e.target.checked)}>I understand this is a sample connection.</Check>}
   <div className="buyer-connection-actions">
    {canTry?<Button type="button" disabled={!consent} onClick={()=>{setConsent(false);onConnect();}}>{['error','rejected'].includes(effective)?'Retry sample connection':'Try sample connection'}<Icon name="arrow" size={18}/></Button>:
     effective==='connecting'?<Button type="button" secondary onClick={onCancel}>Cancel sample connection</Button>:
     effective==='connected'?<Button type="button" secondary onClick={onDisconnect}>Disconnect sample account</Button>:
     <Button type="button" disabled>Connect to Privy</Button>}
    {onRefresh&&!sample&&<button type="button" className="text-button" onClick={onRefresh}>Refresh test status</button>}
   </div>
   <p className="buyer-connection-footnote">{sample?'No real login, wallet or payment is created.':'Token issuance remains disabled.'}</p>
  </div></div>
 </section>;
}
// Hidden for ordinary customers and when the new panel flag is off. This gate only
// reads a same-origin status route; there is deliberately no Privy SDK, token request,
// browser storage or provider login in this release.
export default function BuyerConnection(){
 const [data,setData]=useState(null),[failed,setFailed]=useState(false),[refresh,setRefresh]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();let active=true;
  const hide=()=>{active=false;controller.abort();setData(null);setFailed(false);};
  const load=async()=>{try{const value=await readBuyerConnectionStatus({signal:controller.signal});if(!active)return;setData(value);setFailed(false);}catch{if(active)setFailed(true);}};
  const timeout=setTimeout(()=>controller.abort(),10000);load().finally(()=>clearTimeout(timeout));
  window.addEventListener('relay-session-expired',hide);
  return()=>{active=false;controller.abort();clearTimeout(timeout);window.removeEventListener('relay-session-expired',hide);};
 },[refresh]);
 useEffect(()=>{if(!data)return;const timer=setTimeout(()=>setData(null),Math.max(0,data.expiresAt-Date.now()));return()=>clearTimeout(timer);},[data]);
 if(!data)return null;
 return <BuyerConnectionCard state={failed?'unavailable':'disabled'} onRefresh={()=>setRefresh(v=>v+1)}/>;
}
