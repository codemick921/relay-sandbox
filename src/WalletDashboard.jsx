import React,{useState,useEffect} from 'react';
import {Button,Check,Field,Modal,Notice} from './ui';
import {short} from './api';
import {formatUsdc,inputUsdc,totalWalletBalance,walletShortfall,visibleWallet} from './wallet-values.mjs';

export function WalletDashboard({state,open,act,busy}){
 const [message,setMessage]=useState(''),[now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),15000);return()=>clearInterval(timer);},[]);
 const data=state?.walletBalances;if(!data||!state.agents.length)return null;
 const wallets=data.wallets.map(w=>visibleWallet(w,now)),total=totalWalletBalance(wallets),fundable=state.liveFunding?.paymentsEnabled||state.fundingJourneyEnabled;
 return <section className="panel wallet-dashboard" aria-label="Wallet balances">
  <div className="section-head"><div><h2>{data.simulated?'Example wallet balances':'Your wallet balances'}</h2><p className="muted">USDC on Base · {data.simulated?'Simulated for this preview':'Checked automatically'}</p></div><strong className="wallet-total">{total===null?'Total unavailable':`${formatUsdc(total)} USDC`}</strong></div>
  <p className="fine-print">Balances can change when your agent spends. They are separate from funding receipts. Eupova cannot spend or freeze funds in a saved wallet.</p>
  <div className="wallet-cards">{state.agents.map(agent=>{
   const w=wallets.find(w=>w.agentId===agent.id),shortfall=walletShortfall(w);
   return <article className="wallet-card" key={agent.id}>
    <div className="section-head"><h3>{agent.name}</h3><span className={'status-pill '+(w?.lowBalance?'wallet-low':'')}>{data.simulated?'Example · ':''}{!w||w.status==='unavailable'?'Not checked':w.status==='stale'?'Last known balance':w.lowBalance?'Low balance':'Up to date'}</span></div>
    <code>{short(agent.address)}</code>
    <p className="wallet-amount">{w?.amountRaw==null?'Balance unavailable':`${formatUsdc(w.amountRaw)} USDC`}</p>
    <p className="fine-print">{w?.observedAt?`Checked ${new Date(w.observedAt).toLocaleString('en-GB')}`:'The wallet balance has not been checked yet.'}</p>
    {w?.status==='stale'&&<Notice>Balance check delayed. The last known amount may have changed; low-balance alerts are paused until a fresh check.</Notice>}
    {w?.refreshFailed&&w.status==='unavailable'&&<Notice>We could not read this balance. Eupova will retry automatically.</Notice>}
    {w?.alertsEnabled&&<p className="fine-print">Alert below {formatUsdc(w.thresholdRaw)} USDC · Target {formatUsdc(w.targetRaw)} USDC</p>}
    {w?.lowBalance&&<Notice>{formatUsdc(shortfall)} USDC below your target. Choose a currency and amount and check how much USDC the wallet will receive after fees in the new checkout. No automatic payment will be made.</Notice>}
    <div className="wallet-actions"><Button disabled={busy||!fundable} onClick={()=>open('fund',agent.id)}>{state.liveFunding?.paymentsEnabled?'Fund agent':'Test funding'}</Button><Button secondary disabled={busy||!w} onClick={()=>open('wallet-preferences',agent.id)}>Balance alerts</Button><button className="text-button" disabled={busy} onClick={async()=>{const r=await act('wallet-balances/refresh',{agentId:agent.id});setMessage(r?'Balance refresh requested. Recent checks are limited to once every 30 seconds.':'Refresh could not be requested. Please try again.');}}>Refresh</button></div>
   </article>;
  })}</div><p className="fine-print" role="status">{message}</p>
 </section>;
}
export function WalletPreferences({state,agentId,act,busy,error,onClose}){
 const wallet=state.walletBalances?.wallets.find(w=>w.agentId===agentId),agent=state.agents.find(a=>a.id===agentId);
 const [enabled,setEnabled]=useState(wallet?.alertsEnabled??false),[threshold,setThreshold]=useState(inputUsdc(wallet?.thresholdRaw??'10000000')),[target,setTarget]=useState(inputUsdc(wallet?.targetRaw??'50000000'));
 if(!wallet||!agent)return <Modal title="Balance alerts" onClose={onClose}><Notice>Wallet not available.</Notice></Modal>;
 return <Modal title={`Balance alerts · ${agent.name}`} onClose={busy?()=>{}:onClose}><p>Show a reminder in Eupova when this wallet balance falls below the amount you choose. Alerts use a fresh USDC balance and do not trigger payments or emails.</p>{error&&<Notice error>{error}</Notice>}
  <form onSubmit={async e=>{e.preventDefault();if(await act('wallet-balances/preferences',{agentId,enabled,threshold,target}))onClose();}}>
   <Check checked={enabled} onChange={e=>setEnabled(e.target.checked)}>Show low-balance alerts in Eupova</Check>
   <Field label="Alert below (USDC)"><input required inputMode="decimal" value={threshold} onChange={e=>setThreshold(e.target.value)}/></Field>
   <Field label="Preferred balance (USDC)" hint="A reminder target, not a spending limit or guaranteed funding amount."><input required inputMode="decimal" value={target} onChange={e=>setTarget(e.target.value)}/></Field>
   <Button disabled={busy} className="full">{busy?'Saving…':'Save balance alerts'}</Button>
  </form></Modal>;
}
