import {fundingCatalog} from '../shared/fiat.mjs';
import React from 'react';
import {Modal,Notice,Button,Icon} from './ui';
import {fundingOptions} from './funding-options.mjs';
import './funding-options.css';
import './fund-wallet.css';
export default function FundingOptions({state,open,onClose,selected,fundingPreset}){
 const options=fundingOptions(state);
 const continueFunding=()=>{const a=options.action;if(a)open(a.kind,a.id??selected,a.needsWallet?{continueFunding:true}:options.existing?undefined:fundingPreset);};
 return <Modal title="Funding options" className="fund-options-modal" onClose={onClose}>
  <div className="fund-screen-intro"><span className="fund-screen-icon"><Icon name="bank" size={26}/></span><div><h3>Choose how to fund your wallet.</h3><p>Fund a saved wallet with USDC on Base. Each provider has its own payment steps and checks.</p></div></div>
  {!options.customer?<Notice>Sign in to your customer account to see your funding options.</Notice>:<>
   {options.existing&&<Notice>You have an existing funding request. Review it before starting another. If you have already paid, keep following that request.</Notice>}
   <section className="funding-option" aria-labelledby="peer-option-title">
    <div className="funding-option-heading"><h3 id="peer-option-title">Peer Pay</h3><span className="funding-option-status">{options.live?'Enabled in Eupova':'Payments unavailable'}</span></div>
    <p>{options.live?'Choose your currency and payment method, then review the offer in Peer’s checkout.':'Real Peer payments are currently unavailable in this account.'}</p>
    {options.live&&<><dl className="details"><div><dt>Payment methods</dt><dd>{options.methods.map(m=>m.label).join(' · ')}</dd></div><div><dt>Your wallet receives</dt><dd>USDC on Base</dd></div></dl><p className="fine-print">An enabled method does not guarantee an offer. Peer shows the current amount, fees and payment deadline. Follow its identity and payment-verification steps.</p></>}
    {!options.live&&options.prepare&&!options.existing&&<p>You can save a draft in Eupova. Preparing a draft does not create a Peer checkout or send money.</p>}
    {options.action&&<Button className="full" onClick={continueFunding}>{options.action.label}</Button>}
   </section>
   {state.fundingCalculator?.enabled&&<section className="funding-option"><div className="funding-option-heading"><h3>Plan a USDC target</h3><span className="funding-option-status">Price comparison</span></div><p>Check direct Peer price estimates for the USDC you need. These prices are separate from merchant checkout.</p><Button secondary className="full" onClick={()=>open('target-calculator')}>Compare USDC target prices</Button></section>}
   <details className="funding-option-tests"><summary>Peer payment methods</summary><p>Choose a currency in the funding form to see matching methods. PayPal is excluded.</p><ul>{fundingCatalog.methods.map(m=><li key={m.id}><strong>{m.label}</strong>: {m.currencies.join(', ')}. {m.checkoutSupported?'Checkout integration available; Peer checks account access and offers.':'Not connected to Eupova checkout yet.'}</li>)}</ul></details>
   <section className="funding-option funding-option-unavailable" aria-labelledby="ramp-option-title">
    <div className="funding-option-heading"><h3 id="ramp-option-title">Ramp Network</h3><span className="funding-option-status">Not connected</span></div>
    <p>Ramp cannot accept payments through Eupova yet. There is no live Ramp checkout to open.</p>
    <p className="fine-print">GBP support, payment methods, fees and wallet delivery still need to be confirmed for Eupova before this option can be enabled.</p>
   </section>
   {(options.peerTest||options.rampTest)&&<details className="funding-option-tests"><summary>Test previews · no real funds</summary><p>These separate simulations use example payment data. They do not check provider availability or move money.</p>{options.peerTest&&<Button secondary className="full" onClick={()=>open('peer-fund',selected)}>Preview Peer test flow</Button>}{options.rampTest&&<Button secondary className="full spaced" onClick={()=>open('ramp-fund',selected)}>Preview Ramp test flow</Button>}</details>}
   <p className="fine-print">Viewing these options does not create a request or share your wallet address with a provider.</p>
  </>}
 </Modal>;
}
