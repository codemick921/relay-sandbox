import React,{useEffect,useState} from 'react';
import {Button,Modal,Field,Check,Notice} from './ui';
import {api,gbp} from './api';
import {CheckoutOrder} from './SimpleFunding';
const amount=raw=>Number(raw).toLocaleString('en-GB',{maximumFractionDigits:6});
export function TestFunding({state,act,busy,error,onClose,open,selected}){
 const [agentId,setAgentId]=useState(selected??state.agents[0]?.id??''),[value,setValue]=useState('25'),[quote,setQuote]=useState(null),[loading,setLoading]=useState(false),[localError,setLocalError]=useState(''),[confirmed,setConfirmed]=useState(false),[requestId,setRequestId]=useState(''),[now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const expired=quote&&Date.parse(quote.expiresAt)<=now;
 async function getQuote(e){e.preventDefault();setLoading(true);setLocalError('');try{const r=await api('test-funding/quote',{agentId,amount:value});setQuote(r.quote);setRequestId(crypto.randomUUID());setConfirmed(false);}catch(e){setLocalError(e.message);}finally{setLoading(false);}}
 const existing=state.orders.find(o=>o.journey&&!o.checkoutEnded&&o.status!=='checkout_received');
 return <Modal title={quote?'Review test funding':'Try funding your agent'} onClose={busy||loading?()=>{}:onClose}>
  <Notice>Test journey only. No money moves and nothing is sent to Peer or Wise.</Notice>
  {(error||localError)&&<Notice error>{error||localError}</Notice>}
  {existing?<><p>You already have a test order in progress. Resume it to avoid creating a duplicate.</p><Button className="full" onClick={()=>open('order',existing.id)}>Resume test order</Button></>:!quote?<form onSubmit={getQuote}>
   <Field label="Agent to fund"><select required disabled={loading} value={agentId} onChange={e=>setAgentId(e.target.value)}><option value="" disabled>Choose an agent</option>{state.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
   {!state.agents.length&&<Button type="button" secondary onClick={()=>open('wallet')}>Add agent wallet</Button>}
   <Field label="Test funding amount" hint="Choose £2 to £1,000. This is an example amount, not a payment request."><div className="money-input"><span>£</span><input aria-label="Test funding amount" required disabled={loading} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={value} onChange={e=>setValue(e.target.value)}/></div></Field>
   <Button className="full" disabled={loading||!agentId}>{loading?'Preparing example…':'Review test quote'}</Button>
  </form>:<>
   <dl className="details"><div><dt>Test payment</dt><dd>{gbp(quote.pence)} · Wise</dd></div><div><dt>Example exchange rate</dt><dd>£1 = 1.25 USDC</dd></div><div><dt>Converted amount</dt><dd>{amount(quote.grossUsdc)} USDC</dd></div><div><dt>Example fee deducted</dt><dd>{amount(quote.feeUsdc)} USDC</dd></div><div><dt>Expected test receipt</dt><dd>{amount(quote.netUsdc)} USDC</dd></div><div><dt>Destination</dt><dd>{quote.agent.name} · Base</dd></div></dl>
   <code className="checkout-address">{quote.agent.address}</code>
   <p className="fine-print">Illustrative rate and fee, not a Peer offer. The test fee is deducted from the converted amount. Wallet ownership has not been verified.</p>
   <p role="status">{expired?'This test quote has expired. Get a new quote.':`Valid until ${new Date(quote.expiresAt).toLocaleTimeString('en-GB')}.`}</p>
   <Check checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}>I have checked the receiving address and understand that this is a simulation.</Check>
   <Button className="full spaced" disabled={busy||expired||!confirmed} onClick={async()=>{const s=await act('test-funding/create',{quoteId:quote.id,requestId,confirm:true});if(s)open('order',s.selectedOrderId);}}>{busy?'Saving test order…':'Create test checkout'}</Button>
   <button className="text-button spaced" disabled={busy} onClick={()=>{setQuote(null);setConfirmed(false);}}>Change amount or get a new quote</button>
  </>}
 </Modal>;
}
export function TestOrder(props){
 const {order,act,busy}=props,[checkout,setCheckout]=useState(false),[scenario,setScenario]=useState('success');
 return <CheckoutOrder {...props}>
  <section className="test-checkout" aria-label="Test checkout controls">
   {order.checkoutEnded?<Notice>{order.checkoutExpired?'This test checkout expired before a payment was recorded.':'This test checkout was cancelled.'} No money moved. You can start again with a new quote.</Notice>:!order.testSubmitted?<>
    {!checkout?<><p>Your test checkout is saved. You can close this screen and resume it from Activity.</p><Button className="full" onClick={()=>setCheckout(true)}>Open test checkout</Button></>:<>
     <h3>Simulated Wise checkout</h3><p>No bank details or wallet extension are needed for this test.</p>
     <Field label="Test outcome"><select disabled={busy} value={scenario} onChange={e=>setScenario(e.target.value)}><option value="success">Successful payment and wallet delivery</option><option value="partial">Partial payment, then remaining amount</option><option value="review">Payment needs review</option></select></Field>
     <Button className="full" disabled={busy} onClick={async()=>{if(await act('test-funding/action',{id:order.id,action:'submit',scenario}))setCheckout(false);}}>{busy?'Recording test payment…':'Record simulated payment'}</Button>
     <button className="text-button spaced" disabled={busy} onClick={()=>setCheckout(false)}>Return without paying</button>
    </>}
    <Button secondary className="full spaced" disabled={busy} onClick={()=>act('test-funding/action',{id:order.id,action:'cancel'})}>Cancel test checkout</Button>
   </>:<><Notice>The test payment is recorded. Eupova’s background checks now determine the simulated wallet result; returning here does not confirm arrival.</Notice>{order.testScenario==='partial'&&!order.remainderSent&&<Button disabled={busy} className="full" onClick={()=>act('test-funding/action',{id:order.id,action:'remainder'})}>Simulate the remaining payment</Button>}</>}
   {order.journeyQuote&&<p className="fine-print">Expected test receipt: {amount(order.journeyQuote.netUsdc)} USDC after an illustrative {amount(order.journeyQuote.feeUsdc)} USDC fee. Test checkout expires {new Date(order.checkoutExpiresAt).toLocaleTimeString('en-GB')} if no payment is recorded.</p>}
  </section>
 </CheckoutOrder>;
}
