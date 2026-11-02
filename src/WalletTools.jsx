import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button,Icon} from './ui';
import {BuyerConnectionCard} from './BuyerConnection';
import WalletSetupFlow from './WalletSetupFlow';
import TargetCalculator from './TargetCalculator';
import {createWalletToolsSample,sampleQuote} from './wallet-tools-samples.mjs';
import {readWalletToolsStatus} from './wallet-tools-status.mjs';
import './wallet-tools.css';
const tabs=[['connection','Privy connection','convert'],['setup','Buying wallet','wallet'],['quotes','USDC calculator','bank']];
export default function WalletTools({liveQuotes=false,onWallets}){
 const[tab,setTab]=useState('connection'),[status,setStatus]=useState(null),[refresh,setRefresh]=useState(0),[sampleConnection,setSampleConnection]=useState('ready'),[revision,setRevision]=useState(0),[quoteMode,setQuoteMode]=useState('sample');
 const heading=useRef(null),request=useMemo(()=>createWalletToolsSample(),[revision]);
 useEffect(()=>{const c=new AbortController();let active=true;
  setStatus(null);readWalletToolsStatus({signal:c.signal}).then(v=>{if(active)setStatus(v);});
  const timeout=setTimeout(()=>c.abort(),10000);
  return()=>{active=false;c.abort();clearTimeout(timeout);};
 },[refresh]);
 useEffect(()=>{if(!status)return;const deadline=Math.min(...Object.values(status).filter(v=>v.status==='available').map(v=>v.expiresAt));if(!Number.isFinite(deadline))return;const timer=setTimeout(()=>setStatus(null)||setRefresh(n=>n+1),Math.max(0,deadline-Date.now()));return()=>clearTimeout(timer);},[status]);
 const select=id=>{setTab(id);requestAnimationFrame(()=>heading.current?.focus());};
 const stateLabel=v=>!v?'Checking access…':v.status==='available'?'Restricted test available':v.status==='disabled'?'Not enabled for this account':'Could not check access';
 return <div className="wallet-tools">
  <section className="wallet-tools-intro"><div><span className="wallet-tools-symbol"><Icon name="wallet" size={26}/></span><h2>Get to know your buying wallet.</h2><p>A buying wallet is for direct Peer funding. Your saved agentic wallets remain the destinations where funds should arrive.</p><button type="button" className="text-button" onClick={onWallets}>View my receiving wallets</button></div><div className="wallet-tools-route"><span>Your buying wallet</span><Icon name="arrow" size={22}/><span>Your agentic wallet</span><small>Separate roles. Your saved addresses stay unchanged.</small></div></section>
  <nav className="wallet-tools-tabs" aria-label="Wallet tools">{tabs.map(([id,label,icon])=><button key={id} type="button" aria-current={tab===id?'page':undefined} onClick={()=>select(id)}><Icon name={icon} size={20}/>{label}</button>)}</nav>
  <h2 className="wallet-tools-heading" ref={heading} tabIndex={-1}>{tabs.find(x=>x[0]===tab)[1]}</h2>
  {tab==='connection'&&<>
   <section className="wallet-tools-access" aria-label="Live connection access"><div className="wallet-tools-access-head"><h3>Live access</h3><Button secondary type="button" onClick={()=>setRefresh(n=>n+1)} disabled={!status}>Refresh access</Button></div><p>Privy sign-in and wallet checks are available only during an approved development test.</p>
    <div className="wallet-tools-status-grid">{[['connection','Eupova sign-in with Privy','/buyer-connection-test'],['wallet','Read-only wallet check','/buyer-wallet-auth-test']].map(([id,label,path])=><div key={id}><strong>{label}</strong><span role="status">{stateLabel(status?.[id])}</span>{status?.[id]?.status==='available'&&<a className="btn btn-secondary" href={path}>Open restricted test</a>}</div>)}</div>
    <p className="wallet-tools-note">Opening this page only checks access. It does not connect to Privy or create a wallet.</p>
   </section>
   <div className="wallet-tools-sample-label"><span>Try a sample</span><p>See how connecting and disconnecting will look. No real sign-in takes place.</p></div>
   <BuyerConnectionCard sample state={sampleConnection} onConnect={()=>setSampleConnection('connected')} onDisconnect={()=>setSampleConnection('disconnected')}/>
  </>}
  {['setup','quotes'].includes(tab)&&<section className="wallet-tools-access"><div className="wallet-tools-access-head"><h3>Wallet setup &amp; live quotes</h3><Button secondary type="button" disabled={!status} onClick={()=>setRefresh(n=>n+1)}>Refresh access</Button></div><p>Connect your buying wallet, review your saved receiving address and compare current direct Peer estimates in one flow.</p><p role="status">{stateLabel(status?.flow)}</p>{status?.flow?.status==='available'?<a className="btn" href="/buyer-wallet-flow">Open wallet setup &amp; quotes<Icon name="arrow" size={18}/></a>:<p className="wallet-tools-note">The flow is installed. Live access is awaiting an approved test. Samples below do not connect to Privy or send addresses to Peer.</p>}<p className="wallet-tools-note">Wallet creation has a separate approval. Quotes do not create a payment or a Peer checkout.</p></section>}
  {tab==='setup'&&<>
   <div className="wallet-tools-sample-label"><div><span>Sample walkthrough</span><p>Try setup, wallet checks and address review with example details. Real wallet creation is not enabled.</p></div><Button secondary type="button" onClick={()=>setRevision(n=>n+1)}>Restart sample</Button></div>
   <WalletSetupFlow key={revision} scenario="browser-sample" request={request}/>
  </>}
  {tab==='quotes'&&<>
   <div className="wallet-tools-sample-label"><div><span>{quoteMode==='live'&&liveQuotes?'Live read-only comparison':'Sample quotes'}</span><p>{quoteMode==='live'&&liveQuotes?'Check public direct Peer estimates using example addresses. You cannot pay from this calculator.':'Example rates and fees show how the calculator works. They are not current offers and cannot be paid.'}</p>{!liveQuotes&&<p>Live quote comparison is not enabled for this account. Merchant checkout quotes remain in the funding journey.</p>}</div>{liveQuotes&&<label>Quote source<select value={quoteMode} onChange={e=>setQuoteMode(e.target.value)}><option value="sample">Sample quotes</option><option value="live">Live public estimates</option></select></label>}</div>
   {quoteMode==='live'&&liveQuotes?<TargetCalculator key="live"/>:<TargetCalculator key="sample" sample searchQuotes={input=>Promise.resolve(sampleQuote(input))} reviewQuote={input=>Promise.resolve(sampleQuote(input,{review:true}))}/>}
  </>}
 </div>;
}
