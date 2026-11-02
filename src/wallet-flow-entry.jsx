import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {walletFlowStatus,validWalletFlowStatus} from './wallet-flow-client.mjs';
import mark from './assets/eupova-mark.png';
import './styles.css';
import './wallet-setup.css';
import './wallet-flow.css';
function Page(){
 const[status,setStatus]=useState(null),[phase,setPhase]=useState('checking'),[consent,setConsent]=useState(false),[Sdk,setSdk]=useState(null);
 useEffect(()=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),10000);walletFlowStatus(c.signal).then(v=>{if(!validWalletFlowStatus(v))throw Error();setStatus(v);setPhase('ready');}).catch(()=>setPhase('unavailable')).finally(()=>clearTimeout(t));return()=>{c.abort();clearTimeout(t);};},[]);
 async function connect(){
  if(!consent||phase!=='ready')return;setPhase('loading');const c=new AbortController(),t=setTimeout(()=>c.abort(),10000);
  try{const fresh=await walletFlowStatus(c.signal);if(!validWalletFlowStatus(fresh)||JSON.stringify(fresh)!==JSON.stringify(status))throw Error();const module=await import('./PrivyWalletFlow.jsx');if(fresh.expiresAt<=Date.now())throw Error();setSdk(()=>module.default);setPhase('active');}
  catch{setConsent(false);setPhase('unavailable');}finally{clearTimeout(t);}
 }
 return <main className="wallet-flow-page"><header className="wallet-flow-header"><a className="brand" href="/"><img src={mark} alt=""/>Eupova</a><a href="/">Back to Eupova</a></header><section className="wallet-flow-intro"><span className="wallet-setup-kicker">Restricted development flow</span><h1>Your buying wallet. A clearer funding plan.</h1><p>Connect securely, check your receiving address and compare current direct Peer estimates.</p></section>{Sdk?<Sdk initial={status}/>:<section className="wallet-flow-card"><ol className="wallet-setup-steps"><li>1 · Connect</li><li>2 · Check wallets</li><li>3 · Compare quotes</li></ol><h2>{phase==='ready'?'Connect your approved account':phase==='unavailable'?'Live access is not enabled':'Checking access…'}</h2><p>Your saved agentic wallet remains the receiving destination. A buying wallet has a separate role in direct Peer funding.</p>{phase==='ready'&&<><label className="wallet-setup-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/><span>I agree to connect this test account to Privy and let Eupova check its linked wallet details.</span></label><button className="btn" disabled={!consent} onClick={connect}>Connect and check</button></>}<p className="fine-print">Connecting shares an opaque account identifier with Privy. Creating a wallet and sharing addresses for quotes each need a separate confirmation. This flow cannot create a payment or Peer checkout.</p>{phase==='unavailable'&&<p>Return to Wallet &amp; quotes to use the samples. Real access requires an approved test window.</p>}</section>}</main>;
}
createRoot(document.getElementById('root')).render(<Page/>);
