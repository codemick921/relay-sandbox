import {ReceivingGuideEntry} from './DestinationGuide';
import React,{useEffect,useState} from 'react';
import {Button,Icon,Notice} from './ui';
import {formatUsdc,visibleWallet} from './wallet-values.mjs';
import {fundingEntry} from './funding-entry.mjs';
import './my-agents.css';

function WalletCard({agent,wallet,simulated,entry,state,open,act,busy}){
 const [message,setMessage]=useState('');
 const hasAmount=typeof wallet?.amountRaw==='string'&&/^\d+$/.test(wallet.amountRaw);
 const fresh=wallet?.status==='fresh'&&hasAmount,low=fresh&&wallet.lowBalance;
 const status=!hasAmount?'Balance unavailable':!fresh?'Last known balance':low?'Low balance':'Up to date';
 const checked=wallet?.observedAt&&Number.isFinite(Date.parse(wallet.observedAt))?new Date(wallet.observedAt).toLocaleString('en-GB'):null;
 async function copy(){try{await navigator.clipboard.writeText(agent.address);setMessage('Address copied.');}catch{setMessage('Could not copy. Select and copy the full address below.');}}
 return <article className="managed-wallet" aria-label={agent.name}>
  <header className="managed-wallet-head"><span className="managed-wallet-icon"><Icon name="robot" size={25}/></span><div><h2>{agent.name}</h2><span className="managed-wallet-network">USDC on Base</span></div>{state.account&&<Button secondary disabled={busy} onClick={()=>open('wallet-edit',agent.id)}>Edit wallet</Button>}</header>
  <div className="managed-wallet-body">
   <div className="managed-wallet-balance"><div><span>{simulated?'Example balance':'Wallet balance'}</span><strong>{hasAmount?<>{formatUsdc(wallet.amountRaw)} <small>USDC</small></>:'Unavailable'}</strong></div><span className={'managed-wallet-status '+(!fresh||low?'needs-attention':'')}>{simulated?'Simulated · ':''}{status}</span></div>
   <p className="managed-wallet-checked">{checked?`Checked ${checked}`:'No balance check available yet.'}{hasAmount&&!fresh?' This amount may have changed.':''}</p>
   {low&&<p className="managed-wallet-alert"><Icon name="info" size={18}/>Below your {formatUsdc(wallet.thresholdRaw)} USDC alert threshold.</p>}
   <div className="managed-wallet-address"><div><span>Receiving address</span><button type="button" className="managed-wallet-copy" onClick={copy}><Icon name="copy" size={17}/>Copy address</button></div><code tabIndex={0} aria-label={`Receiving address for ${agent.name}`}>{agent.address}</code></div>
   <div className="managed-wallet-controls"><Button disabled={busy||entry?.disabled||!entry?.kind} onClick={()=>open(entry.kind,entry.id??agent.id)}>{entry?.existing?'Review existing request':entry?.label??'Funding unavailable'}<Icon name="arrow" size={18}/></Button>{state.agentConnections&&<Button secondary disabled={busy} onClick={()=>open('agent-connections',agent.id)}>Agent connections</Button>}<Button secondary disabled={busy||!wallet} onClick={()=>open('wallet-preferences',agent.id)}>Balance alerts</Button></div>
   <div className="managed-wallet-meta"><span>{!wallet?'Balance alerts unavailable':wallet.alertsEnabled?`Alerts below ${formatUsdc(wallet.thresholdRaw)} USDC`:'Balance alerts off'}</span><button type="button" className="managed-wallet-refresh" disabled={busy||!state.walletBalances} onClick={async()=>{setMessage('');const result=await act('wallet-balances/refresh',{agentId:agent.id});setMessage(result?'Balance refresh requested. Checks are limited to once every 30 seconds.':'Could not request a refresh. Please try again.');}}>Refresh balance</button></div>
   <p className="managed-wallet-message" role="status">{message}</p>
  </div>
 </article>;
}
export default function MyAgents({state,open,act,busy}){
 const [query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),15000);return()=>clearInterval(timer);},[]);
 const agents=state.agents??[],data=state.walletBalances;
 const wallets=new Map((data?.wallets??[]).map(w=>[w.agentId,visibleWallet(w,now)]));
 const attention=a=>{const w=wallets.get(a.id);return !w||w.status!=='fresh'||w.amountRaw==null||w.lowBalance;};
 const match=agents.filter(a=>(filter==='all'||attention(a))&&[a.name,a.address].some(v=>v.toLowerCase().includes(query.trim().toLowerCase())));
 const entry=state.account?fundingEntry(state):{kind:'fund',label:'Fund wallet',disabled:state.paymentsDisabled};
 const funding=entry&&!entry.existing&&entry.label==='Fund a wallet'?{...entry,label:'Fund wallet'}:entry;
 return <section className="my-agents" aria-label="Your agentic wallets">
  <div className="agents-toolbar"><div><strong>{agents.length} saved {agents.length===1?'wallet':'wallets'}</strong><p>Receiving addresses for your agents.</p></div><Button disabled={busy} onClick={()=>open('wallet')}><Icon name="plus" size={20}/>Add wallet</Button></div>
  <ReceivingGuideEntry/>
  {!!agents.length&&<div className="agents-find"><label><span>Find a wallet</span><input type="search" placeholder="Search by name or address" value={query} onChange={e=>setQuery(e.target.value)}/></label><div className="agents-filter" role="group" aria-label="Filter wallets"><button type="button" aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>All wallets</button><button type="button" aria-pressed={filter==='attention'} onClick={()=>setFilter('attention')}>Needs attention <span>{agents.filter(attention).length}</span></button></div></div>}
  {data?.simulated&&<Notice>Example balances only. No real funds are shown.</Notice>}
  {agents.length?<><p className="agents-result-count" role="status">{match.length} {match.length===1?'wallet':'wallets'} shown</p>{match.length?<div className="managed-wallet-grid">{match.map(agent=><WalletCard key={agent.id+agent.address} {...{agent,state,open,act,busy}} wallet={wallets.get(agent.id)} simulated={!!data?.simulated} entry={funding}/>)}</div>:<div className="agents-empty"><Icon name="wallet" size={36}/><h2>{query?'No matching wallets':'No wallets need attention'}</h2><p>{query?'Try another name or part of the receiving address.':'Your saved wallets have fresh balances with no low-balance alerts.'}</p><Button secondary onClick={()=>{setQuery('');setFilter('all');}}>Show all wallets</Button></div>}</>:<div className="agents-empty agents-empty--first"><span className="managed-wallet-icon"><Icon name="wallet" size={32}/></span><h2>A home for your agentic wallets.</h2><p>Save a receiving address, follow its USDC balance and keep funding details together.</p><Button onClick={()=>open('wallet')}><Icon name="plus" size={19}/>Add your first wallet</Button><small>Choose an address that accepts USDC on Base.</small></div>}
  <details className="agents-guide"><summary>About your saved wallets</summary><p>Saving an address does not connect a wallet or give Eupova or an agent spending permission. Eupova has not verified ownership.</p><p>Select USDC and Base in your receiving platform before copying its address. A wallet’s name or a valid address format does not prove network support.</p><p>Balances can change when your agent spends. They are separate from payment receipts. Balance alerts are reminders in Eupova and never start payments.</p></details>
 </section>;
}
