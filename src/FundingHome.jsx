import FundingTerms from './FundingTerms';
import React from 'react';
import {Button,Icon} from './ui';
import {fundingEntry} from './funding-entry.mjs';
import './funding-home.css';

export {default as FundingIntroduction} from './Welcome';

function RouteArrow(){return <svg className="journey-arrow" viewBox="0 0 12 24" width="12" height="24" fill="none" aria-hidden="true"><path d="M6 0V22M2 18L6 22L10 18" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>;}
export function FundingRoute({simulation=false,live=false}) {
 return <figure className="funding-journey" aria-labelledby="funding-route-heading">
  <div className="journey-heading"><h3 id="funding-route-heading">How funding works</h3><span>Route guide</span></div>
  <ol className="journey-nodes">
   <li className="journey-node journey-node--currency"><span className="journey-icon"><Icon name="bank" size={25}/></span><div><span>You choose</span><strong>Your currency</strong><small>The amount you want to pay</small></div></li>
   <li className="journey-node journey-node--checkout"><RouteArrow/><span className="journey-icon"><Icon name="convert" size={25}/></span><div><span>You review</span><strong>Peer checkout</strong><small>Offer, fees and payment instructions</small></div></li>
   <li className="journey-node journey-node--wallet"><RouteArrow/><span className="journey-icon"><Icon name="wallet" size={25}/></span><div><span>Destination</span><strong>USDC on Base</strong><small>Your agent’s receiving wallet</small></div></li>
  </ol>
  <figcaption>{simulation?'Test journeys use simulated funds. No real money moves.':live?'Review the current offer before paying. This guide is not a payment status.':'This shows the funding route. Real payments are currently unavailable.'}</figcaption>
 </figure>;
}
export default function FundingHome({state,open,onWallets}) {
 const entry=fundingEntry(state);
 if(!entry)return null;
 const live=!!state.liveFunding?.paymentsEnabled;
 const description=entry.existing?'You have a saved funding request. Check its status and payment instructions before starting another.':entry.disabled?'You can still manage your saved wallets and check earlier requests.':entry.needsWallet?'Start by saving your agent’s receiving address for USDC on Base. Then choose how much to fund.':'Choose a saved wallet and an amount in your currency. Review the offer and payment instructions before paying.';
 return <section className="funding-start" aria-labelledby="funding-start-title">
  <div className="funding-start-content"><p className="funding-eyebrow">{entry.existing?'Continue your funding':live?'Fiat to USDC on Base':state.fundingJourneyEnabled?'Test funding · no real funds':'Funding preparation'}</p><h2 id="funding-start-title">{entry.existing?'Pick up where you left off.':entry.disabled?'Funding is currently unavailable.':'Fund your agent’s wallet.'}</h2><p>{description}</p><div className="funding-start-actions" role="group" aria-label="Wallet funding actions"><Button disabled={entry.disabled} onClick={()=>open(entry.kind,entry.id,entry.needsWallet?{continueFunding:true}:undefined)}>{entry.label}<Icon name={entry.existing?'clock':'arrow'}/></Button><Button secondary onClick={onWallets}><Icon name="wallet" size={19}/>Manage wallets</Button><Button secondary onClick={()=>open('fund')}><Icon name="convert" size={19}/>View funding options</Button></div><p className="funding-caption">{entry.existing?'If you have already paid, follow this request through to wallet delivery.':entry.needsWallet?'You will confirm your Eupova password when saving the address.':live?'Creating a checkout does not send money. You confirm the payment in your payment app.':state.testAccess?'Real checkout access is off for this account. Test receipts do not confirm real funds.':'Real payments are disabled. Test receipts do not confirm real funds.'}</p></div>
  <div className="funding-visual"><FundingRoute simulation={state.testAccess?.mode==='simulation'||(!live&&state.fundingJourneyEnabled)} live={live}/><FundingTerms/></div>
 </section>;
}
