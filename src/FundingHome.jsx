import FundingTerms from './FundingTerms';
import React from 'react';
import {Button,Icon} from './ui';
import {fundingEntry} from './funding-entry.mjs';
import './funding-home.css';

export {default as FundingIntroduction} from './Welcome';

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
