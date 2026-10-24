import React from 'react';

export default function FundingInstructions({preview=false}){
 return <section className="checkout-setup" aria-label="Payment instructions">
  <h3>{preview?'How a live payment will work':'How to complete your payment'}</h3>
  {preview&&<p>This is a guide to the live journey. Do not send money for a draft or simulated checkout.</p>}
  <ol className="funding-instructions">
   <li><strong>Review the checkout.</strong> Peer opens in a separate tab. Check the final GBP total, fees, USDC amount and your agent’s receiving address on Base.</li>
   <li><strong>Follow the current payment instructions.</strong> Use the payment method specified by this checkout, from an account in your name. Copy the exact recipient, amount and any reference, and check the payment deadline. If the recipient cannot be found or the QR code fails, stop; do not guess a replacement.</li>
   <li><strong>Complete verification.</strong> Follow Peer’s instructions after paying, including any phone or app checks it requests. Keep the payment confirmation. If you have paid and the status is still pending, do not pay again.</li>
   <li><strong>Return to Relay.</strong> Open this order in Activity to check the payment and wallet delivery. Reopen the existing checkout if needed. “Funds arrived” means Relay has matched the USDC transfer to your saved wallet in a finalised Base block.</li>
  </ol>
 </section>;
}
