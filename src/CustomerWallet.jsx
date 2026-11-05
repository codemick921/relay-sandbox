import React,{useState} from 'react';
import {Button,Icon,Notice,Modal,Field} from './ui';
import {fundingEntry} from './funding-entry.mjs';
import {trimUsdc,shortAddress,whenText,newRequestId,fundingTarget} from './wallet-view.mjs';
import {WalletApprovals} from './WalletApprovals';
import {WalletConnectedTools} from './WalletConnectedTools';
import WalletBridge from './WalletBridge';
import {WalletProviderSettings} from './WalletProviderSettings';
import {useWalletFlow} from './use-wallet-flow.js';
import './customer-wallet.css';

function CopyAddress({address}){
 const [done,setDone]=useState(false);
 return <Button secondary type="button" className="cw-copy" onClick={async()=>{try{await navigator.clipboard.writeText(address);setDone(true);setTimeout(()=>setDone(false),1800);}catch{setDone(false);}}} aria-label="Copy wallet address">{done?'Copied':'Copy address'}</Button>;
}

export function WalletCard({wallet,balance,onAdd,onReceive,onSend,busy}){
 return <section className="cw-card" aria-label="Your Eupova wallet">
  <div className="cw-card-top"><span className="cw-card-name">{wallet.label}</span>{wallet.simulated&&<span className="cw-badge" title={wallet.addressNote}>Simulated · test money</span>}</div>
  <div className="cw-balance" aria-live="polite"><span className="cw-balance-label">Balance</span><strong>{trimUsdc(balance.usdc)} <small>USDC</small></strong>{balance.reservedUsdc!=='0.000000'&&<span className="cw-reserved">{trimUsdc(balance.reservedUsdc)} reserved for payments in progress</span>}</div>
  <div className="cw-card-meta"><span className={'cw-net '+(wallet.environment==='mainnet'?'cw-net--real':'')}>{wallet.network}</span>{wallet.environment==='mainnet'&&!wallet.simulated&&<span className="cw-net cw-net--real">Real money</span>}<code className="cw-address" title={wallet.address}>{shortAddress(wallet.address)}</code></div>
  <div className="cw-actions" role="group" aria-label="Wallet actions">
   <Button type="button" disabled={busy} onClick={onAdd}><Icon name="plus" size={18}/>Add money</Button>
   <Button type="button" secondary disabled={busy} onClick={onReceive}>Receive</Button>
   <Button type="button" secondary disabled={busy||balance.raw==='0'} onClick={onSend}>Send</Button>
  </div>
 </section>;
}

function CreateWallet({cw,act,busy,error}){
 const [flow,note]=useWalletFlow(act);
 const [name,setName]=useState('My Eupova wallet'),[rid]=useState(newRequestId);
 return <section className="panel cw-create" aria-labelledby="cw-create-title">
  <span className="cw-create-mark" aria-hidden="true"><Icon name="wallet" size={28}/></span>
  <h2 id="cw-create-title">Create your Eupova wallet</h2>
  <p className="cw-lede">A wallet that lives right here in Eupova. No extra app and no browser extension. It is yours: you approve every payment it makes.</p>
  <ul className="cw-points"><li><strong>Add money</strong> with Pay on Eupova, straight into this wallet.</li><li><strong>Send and receive</strong> USDC on {cw.network?.label??'its network'}.</li><li><strong>Connect tools</strong> that can ask to pay, but only ever with your approval.</li></ul>
  {cw.simulated&&<Notice>This is a simulated wallet. It has a fake address and test money only, so it can never hold real funds.</Notice>}
  {!cw.simulated&&cw.network?.mainnet&&<Notice><strong>Real money.</strong> This wallet is on {cw.network.label}. USDC you add is real and payments are final. Only send USDC on this network to its address.</Notice>}
  {!cw.simulated&&cw.network&&!cw.network.mainnet&&<Notice><strong>Test network.</strong> This wallet is on {cw.network.label}. It holds test USDC only.</Notice>}
  {error&&<Notice error>{error}</Notice>}
  {note&&<Notice error>{note}</Notice>}
  <form onSubmit={async e=>{e.preventDefault();await flow.create(name);}}>
   <Field label="Wallet name" hint="You can see this name on your wallet card."><input value={name} maxLength={40} onChange={e=>setName(e.target.value)} required/></Field>
   <Button disabled={busy||name.trim().length<2}>{busy?'Creating your wallet…':'Create my wallet'}</Button>
  </form>
 </section>;
}

function AddMoney({cw,state,act,busy,error,onClose,open}){
 const [pence,setPence]=useState(2500),[rid]=useState(newRequestId);
 const entry=fundingEntry(state),target=fundingTarget(entry,cw.wallet.savedWalletId);
 return <Modal title="Add money" onClose={onClose}>
  {error&&<Notice error>{error}</Notice>}
  <p className="cw-lede">Pay on Eupova delivers USDC to <strong>this same wallet</strong>.</p>
  <code className="cw-address cw-address--block">{cw.wallet.address}</code>
  {target?.mode==='new'&&<div className="cw-option"><div><strong>Pay on Eupova</strong><p>Use the full funding flow with this exact wallet already chosen.</p></div><Button type="button" disabled={busy} onClick={()=>{onClose();open(target.kind,target.id);}}>{entry.label??'Continue'}</Button></div>}
  {target?.mode==='existing'&&<div className="cw-option"><div><strong>A funding request is already open</strong><p>Finish or cancel it first. It is shown in Payments with its own wallet and amount.</p></div><Button type="button" secondary disabled={busy} onClick={()=>{onClose();open(target.kind,target.id);}}>Open it</Button></div>}
  {target?.mode==='unlinked'&&<Notice>Pay on Eupova is not linked to this wallet yet. Your wallet address is above; funding will be offered here as soon as it is.</Notice>}
  {cw.simulated&&<div className="cw-option cw-option--sim"><div><strong>Add instant test money</strong><p>A one-step simulation. No payment is made and no Base receipt is created.</p>
   <div className="cw-chips" role="group" aria-label="Test amount">{[1000,2500,5000].map(p=><button key={p} type="button" className={'cw-chip '+(pence===p?'is-on':'')} aria-pressed={pence===p} onClick={()=>setPence(p)}>£{p/100}</button>)}</div></div>
   <Button type="button" disabled={busy} onClick={async()=>{if(await act('wallet/add-money',{requestId:rid,pence}))onClose();}}>{busy?'Adding…':`Add £${pence/100} of test money`}</Button></div>}
 </Modal>;
}

function Receive({cw,onClose}){
 return <Modal title="Receive" onClose={onClose}>
  <p className="cw-lede">Share this address to receive USDC on <strong>{cw.wallet.network}</strong>. Only send USDC on this network.</p>
  <code className="cw-address cw-address--block">{cw.wallet.address}</code>
  <div className="cw-actions"><CopyAddress address={cw.wallet.address}/></div>
  {cw.wallet.simulated&&<Notice>{cw.wallet.addressNote} Do not send real funds to it.</Notice>}
 </Modal>;
}

function Send({cw,act,busy,error,onClose}){
 const [to,setTo]=useState(''),[amount,setAmount]=useState(''),[rid]=useState(newRequestId);
 const ok=/^0x[0-9a-fA-F]{40}$/.test(to.trim())&&/^\d{1,9}(\.\d{1,6})?$/.test(amount);
 return <Modal title="Send USDC" onClose={onClose}>
  <p className="cw-lede">Nothing is sent yet. You will review the details and approve them before anything leaves your wallet.</p>
  {error&&<Notice error>{error}</Notice>}
  <form onSubmit={async e=>{e.preventDefault();if(await act('wallet/send',{requestId:rid,destination:to.trim(),amount,service:'Send',...(cw.simulated?{maxFee:'0.05'}:{})}))onClose();}}>
   <Field label="To address" hint={`An address on ${cw.network.label} starting with 0x.`}><input value={to} onChange={e=>setTo(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck="false" required/></Field>
   <Field label="Amount (USDC)" hint={cw.simulated?`Available: ${trimUsdc(cw.balance.availableUsdc)} USDC. Up to 0.05 USDC simulated fee.`:cw.fees.asset==='sponsored'?`Available: ${trimUsdc(cw.balance.availableUsdc)} USDC. The network fee is meant to be covered through Circle's Gas Station, which decides whether each payment qualifies.`:`Available: ${trimUsdc(cw.balance.availableUsdc)} USDC. The network fee is an estimate paid in ETH from your wallet; you see it before you approve.`}><input value={amount} onChange={e=>setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" required/></Field>
   <Button disabled={busy||!ok}>{busy?'Preparing…':'Review payment'}</Button>
  </form>
 </Modal>;
}

function Activity({rows}){
 if(!rows.length)return <p className="cw-empty">Your wallet activity will appear here once money moves.</p>;
 return <ul className="cw-activity">{rows.map(r=><li key={r.id} className={'cw-row cw-row--'+(r.direction==='in'?'in':'out')}>
  <span className="cw-row-icon" aria-hidden="true">{r.moved?(r.direction==='in'?'+':'−'):'·'}</span>
  <span className="cw-row-main"><strong>{r.label}</strong><small>{whenText(r.at)}{r.simulated?' · simulated':''}</small></span>
  {r.moved&&r.amountUsdc?<span className="cw-row-amt">{r.direction==='in'?'+':'−'}{trimUsdc(r.amountUsdc)}</span>:<span className="cw-row-status">{r.status==='posted'?'':String(r.status).replace(/_/g,' ')}</span>}</li>)}</ul>;
}

export default function CustomerWallet({state,act,busy,error,open,onBridge}){
 const cw=state.customerWallet,[dialog,setDialog]=useState(null),[flow,flowNote]=useWalletFlow(act);
 if(cw?.unavailable)return <Notice error>Your wallet is not available right now. Nothing has been changed and your money is not affected. Please try again later.</Notice>;
 if(!cw?.enabled)return <Notice>The wallet is not available in this environment.</Notice>;
 if(!cw.wallet)return <div className="cw-hub"><CreateWallet cw={cw} act={act} busy={busy} error={error}/></div>;
 if(cw.wallet.status==='pending_setup')return <div className="cw-hub"><section className="panel cw-create"><h2>Finish setting up your wallet</h2><p className="cw-lede">Your wallet is created once you finish the PIN step. When you have, check again.</p>{error&&<Notice error>{error}</Notice>}{flowNote&&<Notice error>{flowNote}</Notice>}<div className="cw-actions"><Button disabled={busy} onClick={()=>flow.resumeSetup()}>{busy?'Working…':'Continue setup'}</Button><Button secondary disabled={busy} onClick={()=>flow.checkSetup()}>Check again</Button></div></section></div>;
 if(cw.balance?.unavailable)return <div className="cw-hub"><Notice error>{cw.notice}</Notice><Button onClick={()=>act('wallet/finish-setup',{})} secondary>Try again</Button></div>;
 const close=()=>setDialog(null);
 return <div className="cw-hub">
  {cw.simulated&&<Notice><strong>Simulated wallet.</strong> Everything here is test data: a fake address and test money. It is never a real, funded wallet.</Notice>}
  {error&&<Notice error>{error}</Notice>}
  <WalletCard wallet={cw.wallet} balance={cw.balance} busy={busy} onAdd={()=>setDialog('add')} onReceive={()=>setDialog('receive')} onSend={()=>setDialog('send')}/>
  <WalletApprovals cw={cw} act={act} busy={busy}/>
  <section className="panel cw-section" aria-labelledby="cw-activity-title"><h2 id="cw-activity-title">Activity</h2><Activity rows={cw.activity}/></section>
  <WalletBridge cw={cw} act={act} busy={busy} error={error}/>
  <WalletConnectedTools cw={cw} act={act} busy={busy}/>
  {state.arcFunding?.enabled&&<section className="panel cw-section cw-more"><h2>More</h2><p className="cw-lede">Test-network simulation: move test USDC from Base Sepolia to Arc Testnet, or recover a stalled transfer.</p><Button secondary type="button" onClick={onBridge}>Bridge and recovery tools</Button></section>}
  <WalletProviderSettings cw={cw}/>
  {dialog==='add'&&<AddMoney cw={cw} state={state} act={act} busy={busy} error={error} onClose={close} open={open}/>}
  {dialog==='receive'&&<Receive cw={cw} onClose={close}/>}
  {dialog==='send'&&<Send cw={cw} act={act} busy={busy} error={error} onClose={close}/>}
 </div>;
}
