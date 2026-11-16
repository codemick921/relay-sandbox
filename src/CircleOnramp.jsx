import React,{useEffect,useRef,useState} from 'react';
import {Modal,Notice,Button,Field,Check} from './ui';
import {api,short} from './api';
// Circle Onramp (App Kit), sandbox only. Circle's checkout opens in its own window; the wallet that receives the USDC is always one of the
// customer's saved Base wallets, and the server (not this page) reads its address. Browser events below are hints for the screen, never
// proof that money arrived: only the wallet balance on Base shows that.
const EXPIRY_SLACK_MS=30000;
export default function CircleOnramp({state,onClose,selected}){
 const wallets=state.agents.filter(a=>a.network==='Base'&&a.token==='USDC');
 const [agentId,setAgentId]=useState(wallets.find(a=>a.id===selected)?.id??wallets[0]?.id??''),[confirmed,setConfirmed]=useState(false);
 const [phase,setPhase]=useState('idle'),[error,setError]=useState('');
 const kit=useRef(null),session=useRef(null),widget=useRef(null),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;try{widget.current?.close();}catch{/* already closed */}};},[]);
 const wallet=wallets.find(a=>a.id===agentId);
 const choose=id=>{setAgentId(id);setConfirmed(false);session.current=null;setPhase('idle');setError('');};
 async function prepare(e){
  e.preventDefault();setError('');setPhase('preparing');
  try{
   const {AppKit}=await import('@circle-fin/app-kit');
   kit.current??=new AppKit({onramp:{widgetBaseUrl:state.circleOnramp.widgetBaseUrl}});
   const s=await api('onramp/session',{agentId});
   if(!mounted.current)return;
   session.current=s;setPhase('ready');
  }catch(err){if(mounted.current){setError(err.message||'The checkout could not be prepared. Try again.');setPhase('idle');}}
 }
 // Must run directly inside the click: browsers block a window opened after an await.
 function openCheckout(){
  setError('');
  const s=session.current;
  if(!s||!kit.current)return;
  if(Date.parse(s.expiresAt)-EXPIRY_SLACK_MS<=Date.now()){session.current=null;setPhase('idle');setError('This checkout expired. Prepare a new one.');return;}
  try{
   const result=kit.current.onramp.openWindow({session:s});
   if(result.status==='blocked'){setError('Your browser blocked the checkout window. Allow pop-ups for this site and try again.');return;}
   widget.current=result.widget;setPhase('open');
   result.widget.on('DEPOSIT_SUBMITTED',()=>{if(mounted.current)setPhase('submitted');});
   result.widget.on('DEPOSIT_NOT_COMPLETED',({code})=>{if(!mounted.current)return;session.current=null;if(code==='CANCELED_BY_CUSTOMER'){setPhase('idle');}else{setPhase('idle');setError('The checkout ended before payment. You can prepare a new one.');}});
  }catch{session.current=null;setPhase('idle');setError('The checkout could not be opened. Prepare a new one.');}
 }
 return <Modal title="Buy USDC with Circle" onClose={onClose}>
  <Notice>Sandbox test mode. Use test details only. No real money moves and no real USDC is delivered.</Notice>
  {error&&<Notice error>{error}</Notice>}
  {!wallets.length?<><p>Save a Base USDC receiving wallet first. Circle’s checkout only delivers to a wallet saved in Eupova.</p></>:
  <form onSubmit={prepare}>
   <Field label="Receiving wallet" hint="Your saved wallet is the only place this checkout can deliver to."><select value={agentId} disabled={phase==='preparing'||phase==='open'} onChange={e=>choose(e.target.value)}>{wallets.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
   {wallet&&<code className="checkout-address">{wallet.address}</code>}
   <p>Circle’s checkout opens in a separate window. It runs its own identity checks and shows its own price, fees and payment methods before you pay. Eupova does not see your card or bank details.</p>
   {phase==='idle'&&<><Check checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}>I understand this is a sandbox test with {wallet?short(wallet.address):'my saved wallet'} as the destination.</Check><Button className="full spaced" disabled={!wallet||!confirmed}>Prepare checkout</Button></>}
   {phase==='preparing'&&<Button className="full spaced" disabled>Preparing checkout…</Button>}
  </form>}
  {phase==='ready'&&<><Notice>Your checkout is ready and stays valid for a short time.</Notice><Button className="full spaced" onClick={openCheckout}>Open Circle checkout</Button></>}
  {phase==='open'&&<Notice>The checkout is open in another window. Come back here when you are finished.</Notice>}
  {phase==='submitted'&&<div className="receipt"><h3>Purchase submitted</h3><p>Circle accepted the request. Eupova has not confirmed that any USDC arrived. Check this wallet’s balance on Base before relying on it.</p><Button secondary className="full" onClick={()=>{session.current=null;setPhase('idle');setConfirmed(false);}}>Start another test</Button></div>}
 </Modal>;
}
