import {Brand} from './Brand.jsx';
import FundingTerms from './FundingTerms';
import React from 'react';
import {Button,Icon} from './ui';
import {fundingEntry} from './funding-entry.mjs';
import './funding-home.css';

export function FundingIntroduction({onFund,onSignIn}) {
 return <main className="funding-introduction">
  <header className="funding-public-header"><span className="brand"><Brand/></span><Button secondary onClick={onSignIn}>Sign in</Button></header>
  <section className="funding-public-hero" aria-labelledby="funding-intro-title">
   <div><p className="funding-eyebrow">Fund your agent wallet</p><h1 id="funding-intro-title">Put funds where<br/>your agent needs them.</h1><p className="funding-lead">Pay through Peer in your chosen currency and receive USDC in your agent’s wallet on the Base network. Keep your saved wallets and payment history together in Eupova.</p><Button onClick={onFund}>Fund a wallet<Icon name="arrow"/></Button><p className="funding-caption">Create an account or sign in to get started.</p></div>
   <div><FundingRoute/><FundingTerms/></div>
  </section>
  <section className="funding-explainer" aria-label="How funding works">
   <article><span className="funding-step">01</span><h2>Choose your wallet</h2><p>Copy the receiving address from your agent’s wallet. It must support USDC on Base. Never share a private key or recovery phrase.</p></article>
   <article><span className="funding-step">02</span><h2>Review before paying</h2><p>Choose a currency and amount, then check Peer’s offer, fees and payment instructions. Availability and verification depend on the offer.</p></article>
   <article><span className="funding-step">03</span><h2>Follow the funds</h2><p>Return to Eupova to track the payment and check when the USDC transfer to your saved address is confirmed.</p></article>
  </section>
  <p className="funding-public-note">Check the payment mode after signing in. Test payments are labelled as simulations and do not move real money.</p>
 </main>;
}
function FundingRoute() {
 return <div className="funding-route" aria-label="Funding route: Fiat through Peer to USDC on Base">
  <div><span className="route-icon"><Icon name="bank"/></span><p>You pay<strong>Your currency</strong></p></div>
  <div className="funding-route-connector"><Icon name="down"/><span>Peer checkout</span></div>
  <div><span className="route-icon"><Icon name="wallet"/></span><p>Your agent receives<strong>USDC <small>on Base</small></strong></p></div>
  <p className="funding-route-note">Review the current quote in checkout.</p>
 </div>;
}
export default function FundingHome({state,open,onWallets}) {
 const entry=fundingEntry(state);
 if(!entry)return null;
 const live=!!state.liveFunding?.paymentsEnabled;
 const description=entry.existing?'You have a saved funding request. Check its status and payment instructions before starting another.':entry.disabled?'You can still manage your saved wallets and check earlier requests.':entry.needsWallet?'Start by saving your agent’s receiving address for USDC on Base. Then choose how much to fund.':'Choose a saved wallet and an amount in your currency. Review the offer and payment instructions before paying.';
 return <section className="funding-start" aria-labelledby="funding-start-title">
  <div className="funding-start-content"><p className="funding-eyebrow">{entry.existing?'Continue your funding':live?'Fiat to USDC on Base':state.fundingJourneyEnabled?'Test funding · no real funds':'Funding preparation'}</p><h2 id="funding-start-title">{entry.existing?'Pick up where you left off.':entry.disabled?'Funding is currently unavailable.':'Fund your agent’s wallet.'}</h2><p>{description}</p><div className="funding-start-actions"><Button disabled={entry.disabled} onClick={()=>open(entry.kind,entry.id,entry.needsWallet?{continueFunding:true}:undefined)}>{entry.label}<Icon name={entry.existing?'clock':'arrow'}/></Button><button className="text-button" onClick={onWallets}>Manage wallets</button><button className="text-button" onClick={()=>open('fund')}>View funding options</button></div><p className="funding-caption">{entry.existing?'If you have already paid, follow this request through to wallet delivery.':entry.needsWallet?'You will confirm your Eupova password when saving the address.':live?'Creating a checkout does not send money. You confirm the payment in your payment app.':state.testAccess?'Real checkout access is off for this account. Test receipts do not confirm real funds.':'Real payments are disabled. Test receipts do not confirm real funds.'}</p></div>
  <div><FundingRoute/><FundingTerms/></div>
 </section>;
}
