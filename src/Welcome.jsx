import React,{useState,useEffect,useRef} from 'react';
import ribbon from './assets/funding-ribbon.webp';
import ribbonSmall from './assets/funding-ribbon-small.webp';
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
 const panel=useRef(null);
 const [playing,setPlaying]=useState(()=>{try{return !window.matchMedia('(prefers-reduced-motion: reduce)').matches&&sessionStorage.getItem('eupova-welcome-motion')!=='paused';}catch{return false;}});
 const [inView,setInView]=useState(false),[hovered,setHovered]=useState(false),[focused,setFocused]=useState(false),[pageVisible,setPageVisible]=useState(()=>!document.hidden);
 const setMotion=value=>{setPlaying(value);try{sessionStorage.setItem('eupova-welcome-motion',value?'playing':'paused');}catch{}};
 const selectStep=value=>{setMotion(false);setStep(value);};
 useEffect(()=>{
  const media=window.matchMedia('(prefers-reduced-motion: reduce)');
  const changed=()=>{if(media.matches)setMotion(false);};
  const visibility=()=>setPageVisible(!document.hidden);
  const observer=new IntersectionObserver(([entry])=>setInView(entry.isIntersecting),{threshold:.4});
  if(panel.current)observer.observe(panel.current);
  media.addEventListener('change',changed);document.addEventListener('visibilitychange',visibility);
  return()=>{observer.disconnect();media.removeEventListener('change',changed);document.removeEventListener('visibilitychange',visibility);};
 },[]);
 const rotating=playing&&inView&&!hovered&&!focused&&pageVisible;
 useEffect(()=>{if(!rotating)return;const timer=setInterval(()=>setStep(i=>(i+1)%3),8000);return()=>clearInterval(timer);},[rotating]);
 const current=steps[step];
 return <section ref={panel} onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onFocusCapture={()=>setFocused(true)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget))setFocused(false);}} className="welcome-demo" id="funding-example" aria-labelledby="example-heading" tabIndex={-1}>
  <div className="welcome-demo-top"><span className="welcome-demo-label"><span aria-hidden="true"/>Example walkthrough</span><span className="welcome-demo-count" aria-hidden="true">0{step+1} / 03</span></div>
  <nav className="welcome-demo-nav" aria-label="Example steps">{steps.map((s,i)=><button type="button" key={s.name} aria-pressed={i===step} aria-controls="example-scene" onClick={()=>selectStep(i)}><span>0{i+1}</span>{s.name}</button>)}</nav>
  <div className="welcome-demo-body" id="example-scene" data-step={step} key={step}>
   <div className="welcome-demo-caption" aria-live={rotating?'off':'polite'} aria-atomic="true"><p>STEP {step+1} OF 3</p><h2 id="example-heading">{current.title}</h2><p>{current.description}</p></div>
   <div className="welcome-scene">
    {step===0?<><div className="welcome-wallet-heading"><span className="welcome-wallet-icon"><Icon name="robot" size={28}/></span><div><small>Receiving wallet</small><strong>Your agent wallet</strong></div><span className="welcome-asset">USDC</span></div><div className="welcome-route-line"><span><Icon name="bank"/>Your currency</span><span className="welcome-route-arrow" aria-hidden="true"><Icon name="arrow"/></span><span><Icon name="wallet"/>USDC on Base</span></div><div className="welcome-scene-note"><Icon name="info" size={18}/><span>You only need the receiving address. Keep your private key and recovery phrase private.</span></div></>:step===1?<><div className="welcome-review-head"><Icon name="activity"/><strong>Your funding review</strong><span>Example</span></div><dl className="welcome-review-list"><div><dt>Payment currency</dt><dd>Chosen by you</dd></div><div><dt>Amount, rate and fees</dt><dd>Review in checkout</dd></div><div><dt>Destination</dt><dd>USDC on Base</dd></div></dl><p className="welcome-scene-note"><Icon name="info" size={18}/><span>Your bank or wallet may charge separately. Check those costs too.</span></p></>:<><div className="welcome-review-head"><Icon name="activity"/><strong>One saved request</strong><span>Example</span></div><ol className="welcome-timeline"><li><span>1</span><div><strong>Payment</strong><small>Check the payment status</small></div></li><li><span>2</span><div><strong>Transfer</strong><small>Follow the USDC transfer</small></div></li><li><span>3</span><div><strong>Wallet arrival</strong><small>Check the receiving wallet</small></div></li></ol><p className="welcome-scene-note"><Icon name="clock" size={18}/><span>If something needs attention, reopen the saved request before starting another.</span></p></>}
   </div>
  </div>
  <div className="welcome-motion-controls"><p>No money moves in this example.</p><button type="button" onClick={()=>setMotion(!playing)} aria-pressed={!playing}>{playing?'Pause showcase':'Play showcase'}<span aria-hidden="true">{playing?'Ⅱ':'▷'}</span></button></div><div className="welcome-demo-bottom"><span className="welcome-scene-position" aria-hidden="true">{steps.map((_,i)=><i key={i} className={step===i?'selected':''}/>)}</span><button type="button" className="welcome-demo-next" onClick={()=>selectStep((step+1)%3)}>{step===2?'Start again':'Next step'}<Icon name="arrow" size={18}/></button></div>
 </section>;
}
export default function Welcome({onFund,onSignIn,previewMode=false}){
 return <main className="welcome">
  <a className="welcome-skip" href="#welcome-content">Skip to content</a>
  <div className="welcome-shell"><header className="welcome-header"><span className="brand"><Brand/></span><nav aria-label="Welcome navigation"><a href="#welcome-how">Explore Eupova</a><a href="#welcome-questions">Questions</a><button type="button" className="welcome-header-signin" onClick={onSignIn}>Sign in</button><Button onClick={onFund}>Create account</Button></nav></header></div>
  {previewMode&&<div className="welcome-test-banner"><Icon name="info" size={16}/><span>Testing preview. Real payments are disabled.</span></div>}
  <section className="welcome-hero" id="welcome-content" aria-labelledby="welcome-title" tabIndex={-1}>
   <div className="welcome-hero-copy"><p className="welcome-kicker"><span aria-hidden="true"/>Fiat to your agent wallet</p><h1 id="welcome-title">A clear path to<br/>your agent’s wallet.</h1><p className="welcome-lead">Pay through Peer in your chosen currency to fund your agent’s wallet with USDC on Base. Your wallets and funding progress, together in Eupova.</p><div className="welcome-actions"><Button onClick={onFund}>Create account<Icon name="arrow" size={19}/></Button><a className="welcome-example-link" href="#funding-example">See how it works<Icon name="down" size={18}/></a></div><p className="welcome-hero-caption">Save a wallet. Review the offer. Follow the funds.</p></div>
   <figure className="welcome-art"><img src={ribbon} srcSet={`${ribbonSmall} 768w, ${ribbon} 1536w`} sizes="(max-width:760px) 100vw, 60vw" width="1536" height="1024" alt="" fetchPriority="high"/><div className="welcome-art-source"><span className="welcome-art-icon"><Icon name="bank" size={19}/></span><span>Your currency<small>Pay through Peer</small></span></div><div className="welcome-art-destination"><span className="welcome-art-icon"><Icon name="wallet" size={19}/></span><span>USDC on Base<small>Your agent’s wallet</small></span></div><figcaption>Illustration of the funding route</figcaption></figure>
  </section>
  <div className="welcome-shell"><section className="welcome-benefits" aria-label="With your Eupova account">{[['wallet','A home for your wallets','Save the receiving addresses you use.'],['activity','Your funding, in view','Find your requests and payment history.'],['clock','Pick up where you left off','Return to a request that needs attention.']].map(([icon,title,description])=><article key={title}><span className="welcome-benefit-icon"><Icon name={icon} size={22}/></span><div><h2>{title}</h2><p>{description}</p></div></article>)}</section></div>
  <section className="welcome-explore welcome-shell" id="welcome-how" aria-labelledby="welcome-how-title"><div className="welcome-explore-copy"><p className="welcome-kicker">Meet your funding workspace</p><h2 id="welcome-how-title">Every step.<br/>In the picture.</h2><p>From choosing a wallet to checking a saved request, know where to look next.</p><div className="welcome-explore-points"><span><Icon name="wallet" size={18}/>Keep wallet destinations together</span><span><Icon name="activity" size={18}/>Review the offer before paying</span><span><Icon name="clock" size={18}/>Come back to your funding history</span></div><p className="welcome-explore-hint">Explore the example. No account needed.</p></div><Walkthrough/></section>
  <div className="welcome-shell">  <section className="welcome-questions" id="welcome-questions" aria-labelledby="welcome-questions-title"><div><p className="welcome-kicker">Before you begin</p><h2 id="welcome-questions-title">A few useful answers.</h2><p>Know what you need before you create an account.</p></div><div className="welcome-faq">
   <details><summary>What do I need to fund a wallet?</summary><p>An agent wallet that supports USDC on Base and its receiving address. USDC is a stablecoin; Base is the network used for this funding route. Never share your wallet’s private key or recovery phrase. Available currencies, payment methods and verification requirements depend on the offer.</p></details>
   <details><summary>How much will funding cost?</summary><p>Review the amount, exchange rate and fees in Peer checkout before paying. Your bank, payment app or wallet may charge separately. Eupova does not yet provide a guaranteed all-in price covering every possible fee.</p></details>
   <details><summary>Who handles the payment?</summary><p>Peer provides the checkout and payment instructions for the fiat-to-USDC route. Eupova keeps your saved wallet destinations and funding records together so you can return to a request and follow its progress.</p></details>
   <details><summary>What if a payment needs attention?</summary><p>Sign in and open the saved request in Funding history or Payment help. Check its current status and instructions before starting a replacement payment. A saved request does not guarantee delivery or a refund.</p></details>
   {previewMode&&<details><summary>Can I try Tempo funding here?</summary><p>This local preview includes Tempo quote and recovery testing after sign-in. Real fee quotes do not send funds. Payment and delivery examples are simulations; live Tempo settlement is not enabled.</p></details>}
  </div></section>
</div>
  <section className="welcome-closing" aria-labelledby="closing-title"><div className="welcome-shell"><div><p className="welcome-kicker">Your next step</p><h2 id="closing-title">Give your agent wallet<br/>a place to start.</h2><p>Create your account, save your receiving wallet and explore your funding options.</p></div><div className="welcome-closing-actions"><Button onClick={onFund}>Create account<Icon name="arrow" size={20}/></Button><button type="button" onClick={onSignIn}>Already have an account? Sign in</button></div></div></section>
  <footer className="welcome-footer welcome-shell"><span className="brand"><Brand/></span><p>Your wallets and funding history, together.</p><a href="#welcome-questions">Questions about funding</a></footer>
 </main>;
}
