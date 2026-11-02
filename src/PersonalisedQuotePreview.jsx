import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import TargetCalculator from './TargetCalculator';
import {Button,Field,Icon,Notice} from './ui';
import mark from './assets/eupova-mark.png';
import './styles.css';
import './personalised-quote.css';
const scenarios=[['available','Wallets ready'],['noBuyer','No buying wallet'],['expired','Wallet check expired'],['wrongAsset','Receiving network differs'],['changed','Offer changes on review'],['none','No offers'],['revoked','Connection changes during quote']];
function Preview(){
 const[scenario,setScenario]=useState('available'),[walletId,setWalletId]=useState('research'),[context,setContext]=useState(null),[message,setMessage]=useState(''),[consent,setConsent]=useState(false),[revision,setRevision]=useState(0);
 async function query(operation,input){const r=await fetch('/__personalised/'+operation,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario,input})});const d=await r.json();if(!r.ok){const e=Error(d.error);e.status=r.status;e.code=d.error;throw e;}return d;}
 useEffect(()=>{let active=true;setContext(null);setConsent(false);setMessage('');query('context',{receivingWalletId:walletId}).then(c=>{if(active)setContext(c);}).catch(e=>{if(active)setMessage(e.message==='unsupported_receiving_asset'?'This saved destination is not USDC on Base. Choose a compatible receiving wallet.':e.message==='buyer_verification_expired'?'The buying-wallet check has expired. Refresh the connection before requesting prices.':'Wallet details could not be checked. Please try again.');});return()=>{active=false;};},[scenario,walletId,revision]);
 const reset=fn=>{setContext(null);setConsent(false);fn();};
 const request=(operation,input)=>query(operation,{...input,receivingWalletId:walletId,contextId:context.contextId,shareAddresses:true});
 return <main className="target-preview"><header className="target-preview-header"><div className="brand"><img src={mark} alt=""/>Eupova</div><label>Preview scenario<select value={scenario} onChange={e=>reset(()=>setScenario(e.target.value))}>{scenarios.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label></header>
  <div className="target-preview-mode">Sample wallets and prices only. No Privy login, wallet creation, payment or account changes.</div>
  <section className="personalised-context" aria-labelledby="wallet-review-title">
   <span className="target-kicker">Your funding plan</span><h1 id="wallet-review-title">Check where your funds will go.</h1><p>The buying wallet and the receiving wallet can be different. Your agent’s wallet does not need to connect to Eupova for this address review.</p>
   <Field label="Receiving agentic wallet"><select value={walletId} onChange={e=>reset(()=>setWalletId(e.target.value))}><option value="research">Research agent · sample</option><option value="assistant">Assistant · sample</option></select></Field>
   {message?<Notice error>{message}</Notice>:!context?<p role="status">Checking sample wallet details…</p>:context.status==='buyer_wallet_needed'?<Notice>A buying wallet is needed for a personalised quote. The Privy sign-in test does not create one. This preview will not create a wallet.</Notice>:<>
    <div className="personalised-wallets"><div><span className="target-pill"><Icon name="wallet" size={16}/>Buying wallet</span><h2>Your buyer address</h2><code>{context.buyer.address}</code><p>Sample buyer address used for this quote preview.</p></div><div><span className="target-pill"><Icon name="wallet" size={16}/>Receiving wallet</span><h2>{walletId==='research'?'Research agent':'Assistant'}</h2><code>{context.recipient.address}</code><p>Sample destination for the quoted USDC on Base.</p></div></div>
    <p className="fine-print">A saved address does not prove that its platform accepts USDC on Base. Confirm the network in the receiving platform.</p>
    <label className="personalised-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/><span>Use these two sample addresses to preview quotes. No address is sent to Peer in this preview.</span></label>
   </>}
   <Button secondary type="button" className="personalised-refresh" onClick={()=>reset(()=>setRevision(x=>x+1))}>Recheck wallet details</Button>
  </section>
  {consent&&context?.status==='addresses_ready'&&<TargetCalculator key={scenario+context.contextId} addressContext={context} sample searchQuotes={input=>request('quotes',input)} reviewQuote={input=>request('review',input)}/>}
 </main>;
}
createRoot(document.getElementById('root')).render(<Preview/>);
