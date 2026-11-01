import React,{useState} from 'react';
import {Brand} from './Brand.jsx';
import {Button,Icon} from './ui';
import './welcome.css';

const steps=[
 {name:'Wallet',title:'A destination for your agent.',description:'Save a receiving address that supports USDC on the Base network.'},
 {name:'Review',title:'See the offer before you pay.',description:'Choose your currency and amount, then review the offer and payment instructions in Peer checkout.'},
 {name:'Follow',title:'Keep the next step in sight.',description:'Return to your saved request to check progress and follow up if the transfer needs attention.'}
];
function Walkthrough(){
 const [step,setStep]=useState(0);
 const current=steps[step];
 return <section className="welcome-demo" id="funding-example" aria-labelledby="example-heading" tabIndex={-1}>
  <div className="welcome-demo-top"><span className="welcome-demo-label"><span aria-hidden="true"/>Example walkthrough</span><span className="welcome-demo-count" aria-hidden="true">0{step+1} / 03</span></div>
  <nav className="welcome-demo-nav" aria-label="Example steps">{steps.map((s,i)=><button type="button" key={s.name} aria-pressed={i===step} aria-controls="example-scene" onClick={()=>setStep(i)}><span>0{i+1}</span>{s.name}</button>)}</nav>
  <div className="welcome-demo-body" id="example-scene">
   <div className="welcome-demo-caption" aria-live="polite" aria-atomic="true"><p>STEP {step+1} OF 3</p><h2 id="example-heading">{current.title}</h2><p>{current.description}</p></div>
   <div className="welcome-scene">
    {step===0?<><div className="welcome-wallet-heading"><span className="welcome-wallet-icon"><Icon name="robot" size={28}/></span><div><small>Receiving wallet</small><strong>Your agent wallet</strong></div><span className="welcome-asset">USDC</span></div><div className="welcome-route-line"><span><Icon name="bank"/>Your currency</span><span className="welcome-route-arrow" aria-hidden="true"><Icon name="arrow"/></span><span><Icon name="wallet"/>USDC on Base</span></div><div className="welcome-scene-note"><Icon name="info" size={18}/><span>You only need the receiving address. Keep your private key and recovery phrase private.</span></div></>:step===1?<><div className="welcome-review-head"><Icon name="activity"/><strong>Your funding review</strong><span>Example</span></div><dl className="welcome-review-list"><div><dt>Payment currency</dt><dd>Chosen by you</dd></div><div><dt>Amount, rate and fees</dt><dd>Review in checkout</dd></div><div><dt>Destination</dt><dd>USDC on Base</dd></div></dl><p className="welcome-scene-note"><Icon name="info" size={18}/><span>Your bank or wallet may charge separately. Check those costs too.</span></p></>:<><div className="welcome-review-head"><Icon name="activity"/><strong>One saved request</strong><span>Example</span></div><ol className="welcome-timeline"><li><span>1</span><div><strong>Payment</strong><small>Check the payment status</small></div></li><li><span>2</span><div><strong>Transfer</strong><small>Follow the USDC transfer</small></div></li><li><span>3</span><div><strong>Wallet arrival</strong><small>Check the receiving wallet</small></div></li></ol><p className="welcome-scene-note"><Icon name="clock" size={18}/><span>If something needs attention, reopen the saved request before starting another.</span></p></>}
   </div>
  </div>
  <div className="welcome-demo-bottom"><p>No money moves in this example.</p><button type="button" className="welcome-demo-next" onClick={()=>setStep((step+1)%3)}>{step===2?'Start again':'Next step'}<Icon name="arrow" size={18}/></button></div>
 </section>;
}
export default function Welcome({onFund,onSignIn,previewMode=false}){
 return <main className="welcome">
  <a className="welcome-skip" href="#welcome-content">Skip to content</a>
  <header className="welcome-header"><span className="brand"><Brand/></span><nav aria-label="Welcome navigation"><a href="#welcome-how">How it works</a><a href="#welcome-questions">Questions</a><Button secondary onClick={onSignIn}>Sign in<Icon name="arrow" size={18}/></Button></nav></header>
  {previewMode&&<p className="welcome-test-note"><Icon name="info" size={16}/><span>Testing preview. Real payments are disabled.</span></p>}
  <section className="welcome-hero" id="welcome-content" aria-labelledby="welcome-title" tabIndex={-1}>
   <div className="welcome-hero-copy"><p className="welcome-eyebrow"><span aria-hidden="true"/>YOUR CURRENCY. YOUR AGENT WALLET.</p><h1 id="welcome-title">Fund your agent.<br/><span>Follow every step.</span></h1><p className="welcome-lead">Pay through Peer in your chosen currency to fund your agent’s wallet with USDC on Base. Keep your wallets and funding progress together in Eupova.</p><div className="welcome-actions"><Button onClick={onFund}>Create account<Icon name="arrow"/></Button><Button secondary onClick={onSignIn}>Sign in</Button></div><a className="welcome-example-link" href="#funding-example"><span className="welcome-play" aria-hidden="true">→</span>Explore the funding example</a><div className="welcome-route-summary"><span>Your currency</span><Icon name="arrow" size={16}/><span>Peer checkout</span><Icon name="arrow" size={16}/><strong>USDC on Base</strong></div></div>
   <Walkthrough/>
  </section>
  <section className="welcome-benefits" aria-label="With your Eupova account">{[['wallet','Your wallets, ready to find','Save receiving addresses for the agents you use.'],['activity','Your funding, in one place','Find your requests and payment history together.'],['clock','A way back to your request','Return to a saved request when you need to follow up.']].map(([icon,title,description])=><article key={title}><Icon name={icon} size={24}/><div><h2>{title}</h2><p>{description}</p></div></article>)}</section>
  <section className="welcome-details" id="welcome-how" aria-labelledby="welcome-how-title"><div className="welcome-section-intro"><p className="welcome-eyebrow">FROM YOUR FIRST SIGN-IN</p><h2 id="welcome-how-title">A place to start.<br/>A way to keep track.</h2><p>Set up your account, choose a wallet and review your funding options.</p></div><ol className="welcome-setup">{[['Create your account','Keep your saved wallets and funding history together. Save the recovery code provided during sign-up.'],['Add your agent’s wallet','Use a receiving address that supports USDC on Base. Check the network and address carefully.'],['Review your funding options','Choose a currency and amount. Check the payment mode, offer, fees and instructions before paying.']].map(([title,description],i)=><li key={title}><span>0{i+1}</span><div><h3>{title}</h3><p>{description}</p></div></li>)}</ol></section>
  <section className="welcome-questions" id="welcome-questions" aria-labelledby="welcome-questions-title"><div><p className="welcome-eyebrow">BEFORE YOU BEGIN</p><h2 id="welcome-questions-title">A few useful answers.</h2><p>Know what you need before you create an account.</p></div><div className="welcome-faq">
   <details><summary>What do I need to fund a wallet?</summary><p>An agent wallet that supports USDC on Base and its receiving address. USDC is a stablecoin; Base is the network used for this funding route. Never share your wallet’s private key or recovery phrase. Available currencies, payment methods and verification requirements depend on the offer.</p></details>
   <details><summary>How much will funding cost?</summary><p>Review the amount, exchange rate and fees in Peer checkout before paying. Your bank, payment app or wallet may charge separately. Eupova does not yet provide a guaranteed all-in price covering every possible fee.</p></details>
   <details><summary>Who handles the payment?</summary><p>Peer provides the checkout and payment instructions for the fiat-to-USDC route. Eupova keeps your saved wallet destinations and funding records together so you can return to a request and follow its progress.</p></details>
   <details><summary>What if a payment needs attention?</summary><p>Sign in and open the saved request in Funding history or Payment help. Check its current status and instructions before starting a replacement payment. A saved request does not guarantee delivery or a refund.</p></details>
   {previewMode&&<details><summary>Can I try Tempo funding here?</summary><p>This local preview includes Tempo quote and recovery testing after sign-in. Real fee quotes do not send funds. Payment and delivery examples are simulations; live Tempo settlement is not enabled.</p></details>}
  </div></section>
  <footer className="welcome-footer"><span className="brand"><Brand/></span><p>Your wallets and funding history, together.</p><button type="button" className="welcome-footer-signin" onClick={onSignIn}>Sign in to Eupova<Icon name="arrow" size={18}/></button></footer>
 </main>;
}
