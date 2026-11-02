import React,{useEffect,useRef,useState} from 'react';
import {createWalletSetupController} from './wallet-setup-state.mjs';
import TargetCalculator from './TargetCalculator';
import {Icon} from './ui';
import './wallet-setup.css';
const messages={
 checking:['Checking your sample account…','Looking for an existing buying wallet first.'],
 ready:['Ready to try wallet setup','This example has no buying wallet yet.'],
 creating:['Creating the sample wallet…','You can leave this step. Check the result before trying again.'],
 existing:['A sample buying wallet was found','Check this wallet before continuing. Another wallet will not be created.'],
 created:['Sample wallet created','The account and receiving details still need checking.'],
 verifying:['Checking your sample wallets…','Checking the buying wallet against the sample account and saved destination.'],
 verified:['Your sample wallets are ready to review','Check the addresses below before comparing sample prices.'],
 unknown:['The wallet status is not confirmed','Check wallet status before trying again. Leaving this screen does not cancel an attempt already sent.'],
 cancelled:['Sample setup cancelled','You can check the account again when you are ready.'],
 failed:['The sample wallet could not be created','This example returned a confirmed failure. Check the account again before retrying.'],
 expired:['Your sample session has expired','Restart the sample to continue. Real testing will require a fresh Eupova sign-in.'],
 wrongIdentity:['The sample account does not match','Wallet setup is blocked. The account and buying wallet must belong to the same user.'],
 verificationFailed:['The sample wallet check did not pass','Prices are hidden until the buying wallet and receiving details can be checked.']
};
export default function WalletSetupFlow({scenario,request}){
 const [state,setState]=useState({phase:'checking'}),[share,setShare]=useState(false),heading=useRef(null),control=useRef(null);
 useEffect(()=>{const driver={mode:'sample-only',inspect:()=>request('inspect'),create:()=>request('create'),verify:()=>request('verify')};const c=createWalletSetupController({driver,onChange:setState});control.current=c;c.inspect();const timer=setInterval(()=>c.expire(),500);return()=>{c.dispose();clearInterval(timer);};},[scenario,request]);
 useEffect(()=>{setShare(false);if(state.phase!=='checking')heading.current?.focus({preventScroll:true});},[state.phase]);
 const [title,detail]=messages[state.phase],busy=['checking','creating','verifying'].includes(state.phase);
 const step=state.phase==='verified'?2:state.phase==='existing'||state.phase==='verifying'?1:0;
 const sendQuote=(op,input)=>request(op,{...input,contextId:state.context.contextId,receivingWalletId:'research',shareAddresses:true});
 return <>
  <ol className="wallet-setup-steps" aria-label="Wallet setup progress">{['Set up wallet','Check wallet','Review addresses'].map((s,i)=><li key={s} aria-current={step===i?'step':undefined}><span>{i<step?<Icon name="check" size={17}/>:i+1}</span>{s}</li>)}</ol>
  <div className="wallet-setup-grid">
   <section className="wallet-setup-explainer" aria-labelledby="wallet-roles"><span className="wallet-setup-kicker">Two wallets, different roles</span><h2 id="wallet-roles">Your buying wallet.<br/>Your agent’s destination.</h2>
    <div className="wallet-role"><span className="wallet-role-icon"><Icon name="wallet" size={24}/></span><div><h3>Buying wallet</h3><p>A user-controlled wallet for future direct Peer funding. It is separate from your agentic receiving wallet.</p><span className="wallet-setup-tag">Privy · Ethereum-compatible</span></div></div>
    <div className="wallet-role wallet-role-receiving"><span className="wallet-role-icon"><Icon name="robot" size={24}/></span><div><h3>Receiving wallet</h3><p>Your saved agentic wallet, where the USDC would arrive. Setting up a buying wallet does not change this destination.</p><span className="wallet-setup-tag">USDC on Base</span></div></div>
    <details className="wallet-setup-recovery"><summary>Access and recovery</summary><p>The recovery method must be confirmed before a real wallet is created. This preview does not set up recovery or ask for a private key.</p><p>Real wallet creation is unavailable in this preview.</p></details>
   </section>
   <section className="wallet-setup-panel" aria-labelledby="setup-status-title" aria-busy={busy}>
    <span className="wallet-setup-kicker">Sample wallet setup</span><div className={'wallet-setup-state-icon '+(state.phase==='verified'?'is-ready':'')}><Icon name={state.phase==='verified'?'check':busy?'clock':'wallet'} size={30}/></div>
    <div role="status" aria-live="polite"><h2 id="setup-status-title" tabIndex={-1} ref={heading}>{title}</h2><p>{detail}</p></div>
    {state.wallet&&<div className="wallet-setup-address"><span>Buying address · sample</span><code>{state.wallet.address}</code></div>}
    {state.phase==='ready'&&<><label className="wallet-setup-consent"><input type="checkbox" checked={!!state.consent} onChange={e=>control.current.consent(e.target.checked)}/><span>I want to try creating one sample buying wallet. This does not create a real wallet.</span></label><button className="btn" disabled={!state.consent} onClick={()=>control.current.create()}>Create sample buying wallet<Icon name="arrow" size={19}/></button></>}
    {state.phase==='existing'&&<button className="btn" onClick={()=>control.current.verify()}>Check this sample wallet<Icon name="arrow" size={19}/></button>}
    {['unknown','failed','cancelled','verificationFailed'].includes(state.phase)&&<button className="btn" onClick={()=>control.current.inspect()}>Check wallet status</button>}
    {state.phase==='verified'&&<div className="wallet-setup-pass"><Icon name="check" size={18}/>Sample checks passed · no real wallet created</div>}
    {['ready','existing','creating'].includes(state.phase)&&<button className="btn btn-secondary wallet-setup-secondary" onClick={()=>control.current.cancel()}>{state.phase==='creating'?'Leave this step':'Cancel setup'}</button>}
    <p className="wallet-setup-footnote">No payment, checkout, transaction or signature is created here.</p>
   </section>
  </div>
  {state.phase==='verified'&&state.context&&<section className="wallet-setup-review" aria-labelledby="address-review"><div><span className="wallet-setup-kicker">Before you compare</span><h2 id="address-review">Check both sample addresses.</h2><p>Your agentic wallet remains the receiving destination.</p></div><div className="wallet-setup-address-grid"><div className="wallet-setup-address"><span>Buying wallet · sample</span><code>{state.context.buyer.address}</code></div><div className="wallet-setup-address"><span>Research agent · sample · USDC on Base</span><code>{state.context.recipient.address}</code></div></div><label className="wallet-setup-consent"><input type="checkbox" checked={share} onChange={e=>setShare(e.target.checked)}/><span>Use these sample addresses to compare prices. No address is sent to Peer.</span></label><button className="btn btn-secondary" onClick={()=>{setShare(false);control.current.verify();}}>Recheck sample wallets</button></section>}
  {share&&state.phase==='verified'&&<TargetCalculator key={state.context.contextId} sample addressContext={state.context} searchQuotes={input=>sendQuote('quotes',input)} reviewQuote={input=>sendQuote('review',input)}/>}
 </>;
}
