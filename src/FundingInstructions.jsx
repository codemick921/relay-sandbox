import {formatFiat,methodLabel} from '../shared/fiat.mjs';
import React from 'react';

export default function FundingInstructions({preview=false,rail,currency='GBP',requestedPence,stage='ready'}){
 const method=rail?methodLabel(rail):'the payment app shown in Peer';
 const tracking=['partial','tracking','stopped','closed','review'].includes(stage);
 return <section className="checkout-setup" aria-label="Payment instructions">
  <h3>{preview?'Before you create a checkout':tracking?'What to do next':'How to complete your payment'}</h3>
  {preview&&<p>This is a guide to the live journey. Do not send money for a draft or simulated checkout.</p>}
  {!preview&&Number.isSafeInteger(requestedPence)&&<p>You requested {formatFiat(requestedPence,currency)} of funding. This is not a bank-transfer instruction. Check Peer’s current total, currency and recipient before paying.</p>}
  {tracking?<p>{stage==='stopped'?'This request was stopped in Eupova. Do not use its old checkout or payment instructions. Eupova continues checking for late funds.':stage==='closed'?'This checkout has ended. Check the receipt or final status in Eupova. Do not send another payment to its recipient.':'If you have sent or scheduled the payment, do not pay again. Complete any verification requested in the existing Peer checkout, then follow payment and wallet tracking here.'}</p>:<>
  <ol className="funding-instructions">
   <li><strong>Open your saved Peer checkout.</strong> Check the final payment amount and currency, fees, USDC amount and receiving address. Use an offer in your selected currency; do not assume a different currency is equivalent.</li>
   <li><strong>Pay using {method}.</strong> Follow the method shown in that checkout, using an account in your name. Check the exact recipient, amount, reference if provided, and payment deadline before confirming in your payment app.</li>
   <li><strong>Return to the same Peer checkout.</strong> Follow its payment-verification steps, including any phone or app checks. Keep your payment confirmation. If you have already paid, do not pay again because the screen is still pending.</li>
   <li><strong>Track the result in Eupova.</strong> Open this request in Activity. Eupova shows payment verification and wallet delivery separately. Eupova shows “Funds arrived” only after the Base network gives the matching USDC transfer its final confirmation.</li>
  </ol>
  {!preview&&<details className="payment-help"><summary>QR code failed, recipient missing or amount changed?</summary><p>Stop before paying. Reopen the same checkout to check its current instructions. Do not search for a similar recipient, reuse an old reference or change the amount yourself.</p><p>If you have not sent or scheduled payment, use “Cancel this request and start again” when Eupova offers it. This does not cancel the old Peer checkout. If you have paid, keep tracking the original order and do not pay a replacement.</p></details>}
  </>}
 </section>;
}
