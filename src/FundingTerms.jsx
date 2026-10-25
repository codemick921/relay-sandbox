import React from 'react';
export default function FundingTerms(){
 return <details className="funding-terms"><summary>What do these terms mean?</summary>
  <dl>
   <div><dt>GBP and USDC</dt><dd>GBP means British pounds. USDC is the digital currency sent to your agent’s wallet. The GBP amount you choose is separate from the USDC amount the wallet receives.</dd></div>
   <div><dt>Base network</dt><dd>Base is the network used to send USDC to your wallet. Check in your wallet app that its receiving address supports USDC on Base.</dd></div>
   <div><dt>Offer and fees</dt><dd>Peer’s checkout shows the available exchange rate and payment instructions. Review the amount, currency and fees there before paying.</dd></div>
   <div><dt>Payment confirmed and funds arrived</dt><dd>Peer confirms the payment. Relay checks the matching wallet transfer separately and waits for the Base network’s final confirmation before showing “Funds arrived”.</dd></div>
  </dl>
 </details>;
}
