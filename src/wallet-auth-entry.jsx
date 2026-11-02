import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {walletAuthStatus,validWalletAuthStatus} from './wallet-bootstrap-client.mjs';
import {WalletAuthFailure,safeWalletAuthDiagnostic,walletAuthStages} from '../shared/wallet-auth-diagnostics.mjs';
import mark from './assets/eupova-mark.png';
import './buyer-connection-page.css';
function Page(){
 const [status,setStatus]=useState(null),[phase,setPhase]=useState('checking'),[consent,setConsent]=useState(false),[Sdk,setSdk]=useState(null),[failure,setFailure]=useState(null);
 useEffect(()=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),10000);walletAuthStatus(c.signal).then(v=>{if(!validWalletAuthStatus(v))throw Error();setStatus(v);setPhase('ready');}).catch(()=>setPhase('unavailable')).finally(()=>clearTimeout(t));return()=>{c.abort();clearTimeout(t);};},[]);
 async function connect(){
  if(!consent||phase!=='ready')return;setPhase('loading');setFailure(null);
  const c=new AbortController(),t=setTimeout(()=>c.abort(),10000);let stage='eligibility';
  try{
   const fresh=await walletAuthStatus(c.signal);
   if(!validWalletAuthStatus(fresh)||JSON.stringify(fresh)!==JSON.stringify(status))throw new WalletAuthFailure('eligibility','access_changed');
   stage='client_preparation';const sdk=await import('./PrivyWalletAuthSdk.jsx');
   if(fresh.expiresAt<=Date.now())throw new WalletAuthFailure('eligibility','access_changed');
   setSdk(()=>sdk.default);setPhase('active');
  }catch(error){setFailure(safeWalletAuthDiagnostic(error?.diagnostic)??{stage,code:c.signal.aborted?'timeout':'failed'});setPhase('unavailable');}
  finally{clearTimeout(t);}
 }
 return <main className="privy-test-page wallet-auth-page"><a className="privy-test-brand" href="/"><img src={mark} alt=""/>Eupova</a><section className="privy-test-card"><header><span className="buyer-connection-label">Development only</span><h1>Check your buying wallet.</h1><p>Confirm your approved account and see whether its buying wallet matches the test details.</p></header><div className="privy-test-grid"><div><h2>A separate check before funding.</h2><p>Your buying wallet is separate from the saved wallet that receives your agent’s funds.</p><p>This check does not create a wallet, change your receiving address or start a payment.</p><details><summary>What is shared with Privy?</summary><p>An opaque account identifier and a short-lived sign-in token. Privy manages this sign-in session in your browser. Eupova then reads the linked wallet details and checks them against the approved test.</p></details></div><div className="privy-test-panel">{Sdk?<Sdk initial={status}/>:<><h2>{phase==='ready'?'Ready when you are.':phase==='unavailable'?'Test access unavailable.':'Checking access…'}</h2>{failure&&<p>Stopped at: {walletAuthStages[failure.stage]} ({failure.code}).</p>}{phase==='ready'&&<><label className="privy-test-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>I agree to connect my approved test account and check its buying wallet.</label><button className="btn" disabled={!consent} onClick={connect}>Connect and check</button></>}<p>This test is available only during an approved development session.</p></>}</div></div><a className="privy-test-back" href="/">Back to Eupova</a></section></main>;
}
createRoot(document.getElementById('root')).render(<Page/>);
