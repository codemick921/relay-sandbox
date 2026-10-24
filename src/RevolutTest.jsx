import React,{useState} from 'react';
import {api,gbp} from './api';
import {Button,Check,Notice} from './ui';
export default function RevolutTest({test,open}){
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[link,setLink]=useState(null);
 if(!test?.id)return null;
 const ready=test.approved&&test.status==='bound';
 async function review(){setBusy(true);setError('');setLink(null);try{const r=await api('revolut-test/checkout',{id:test.id,confirm:confirmed});setLink(r.checkoutUrl);}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="panel spaced" aria-label="Private Revolut funding test">
  <h2>Your Revolut funding test</h2>
  <p>This private test uses your existing Revolut GBP balance. General payment creation remains disabled.</p>
  <dl className="details"><div><dt>Order amount</dt><dd>{gbp(test.pence)}</dd></div><div><dt>Total test budget</dt><dd>{gbp(test.maxTotalPence)}, including any fees</dd></div><div><dt>Destination</dt><dd>USDC on Base · {test.agent.name}</dd></div><div><dt>Status</dt><dd>{test.revoked?'Approval revoked':test.expired?'Approval expired':test.status==='bound'?'Live checkout created · final review needed':test.status==='closed'?'Wallet delivery verified':test.status==='draft'?'Approved · checkout not created':'Creation needs reconciliation'}</dd></div></dl>
  <code className="checkout-address">{test.agent.address}</code>
  <p>Peer fees reduce the USDC you receive. Before paying, check the final GBP amount and any fees in Peer and Revolut. Stop if the amount differs from this order or the total exceeds your test budget.</p>
  <p>Pay once. Relay cannot prevent or reverse a transfer made in Revolut. If the payment is partial, expires or needs review, do not send another payment. Follow Peer’s iPhone verification instructions.</p>
  {error&&<Notice error>{error}</Notice>}
  {ready&&<><Check checked={confirmed} onChange={e=>{setConfirmed(e.target.checked);setLink(null);}}>I will review the final amount and recipient, pay once from my GBP balance and stay within the total budget.</Check><Button className="full spaced" disabled={busy||!confirmed} onClick={review}>{busy?'Checking the saved order…':'Check and open my existing checkout'}</Button>{link&&confirmed&&<a className="button full spaced" href={link} target="_blank" rel="noopener noreferrer">Open Peer for final review ↗</a>}</>}
  {['bound','closed'].includes(test.status)&&<Button secondary className="full spaced" onClick={()=>open('order',test.id)}>Track payment and wallet delivery</Button>}
 </section>;
}
