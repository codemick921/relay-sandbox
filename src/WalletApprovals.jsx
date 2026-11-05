import React from 'react';
import {Button,Notice} from './ui';
import {trimUsdc,whenText} from './wallet-view.mjs';
import {useWalletFlow} from './use-wallet-flow.js';

function Detail({label,children}){return <div className="cw-detail"><dt>{label}</dt><dd>{children}</dd></div>;}

export function PaymentDetails({p}){
 return <dl className="cw-details">
  <Detail label="Service">{p.service}{p.tool?` · requested by ${p.tool.name}`:' · started by you'}</Detail>
  <Detail label="To"><code className="cw-address cw-address--block">{p.destination}</code></Detail>
  <Detail label="Amount"><strong>{trimUsdc(p.amountUsdc)} USDC</strong></Detail>
  {p.fee.asset==='ETH'?<><Detail label="Estimated network fee">About <strong>{p.fee.nativeMax} {p.fee.nativeSymbol}</strong>, paid from the {p.fee.nativeSymbol} in your wallet, not in USDC. This is Circle's estimate, not a guaranteed limit: Base can add a small data fee that is not included, so keep some extra {p.fee.nativeSymbol}.</Detail><Detail label="Most USDC that can leave your wallet"><strong>{trimUsdc(p.capUsdc)} USDC</strong></Detail></>
   :p.fee.asset==='sponsored'?<><Detail label="Network fee">Meant to be covered by Eupova through Circle's Gas Station. Circle decides whether each transaction qualifies, so this cannot be promised: if it does not, the payment may be refused or your wallet may be asked for the fee. If Eupova's own daily limit for sponsored fees is used up, the payment is not started.</Detail><Detail label="Most USDC that can leave your wallet"><strong>{trimUsdc(p.capUsdc)} USDC</strong></Detail></>
   :<><Detail label="Maximum network fee">{trimUsdc(p.maxFeeUsdc)} USDC (simulated)</Detail><Detail label="Most that can leave your wallet"><strong>{trimUsdc(p.capUsdc)} USDC</strong></Detail></>}
  <Detail label="Token and network">USDC on {p.network}{p.mainnet?' · real money':''}</Detail>
  <Detail label="Fingerprint"><code title={p.fingerprint}>{p.shortFingerprint}</code></Detail>
 </dl>;
}

function Waiting({p,act,busy}){
 const [flow,note]=useWalletFlow(act);
 const decide=decision=>flow.decide(p,decision);
 return <li className="cw-approval">
  <header><h3>{p.service}</h3><span className="cw-pill cw-pill--wait">{p.statusLabel}</span></header>
  <PaymentDetails p={p}/>
  {p.tool&&<p className="cw-note">You allowed <strong>{p.tool.name}</strong> to ask for payments. That alone does not pay anything: this payment still needs your approval.</p>}
  {note&&<Notice error>{note}</Notice>}
  <p className="cw-note">If anything here changes, or the request lapses ({whenText(p.expiresAt)}), your approval stops counting.</p>
  <div className="cw-actions"><Button type="button" disabled={busy||!p.canApprove} onClick={()=>decide('approve')}>{busy?'Working…':'Approve payment'}</Button><Button type="button" secondary disabled={busy||!p.canDecline} onClick={()=>decide('decline')}>Decline</Button></div>
 </li>;
}

function Unknown({p,act,busy,cw}){
 const say=outcome=>act('wallet/payments/reconcile',{id:p.id,outcome});
 return <li className="cw-approval cw-approval--unknown">
  <header><h3>{p.service}</h3><span className="cw-pill cw-pill--warn">{p.statusLabel}</span></header>
  <PaymentDetails p={p}/>
  <Notice error>We could not confirm whether this payment was sent. The money is held back and nothing will be retried for you. Check where it was going, then tell us what happened.</Notice>
  <div className="cw-actions">{cw.live&&<Button type="button" disabled={busy} onClick={()=>act('wallet/payments/refresh',{id:p.id})}>Check with the network</Button>}<Button type="button" secondary disabled={busy} onClick={()=>say('not_sent')}>{cw.live?'Confirm nothing was sent':'It was not sent'}</Button>{!cw.live&&<Button type="button" secondary disabled={busy} onClick={()=>say('sent')}>It was sent</Button>}</div>
 </li>;
}

function InProgress({p,act,busy}){
 const [flow,note]=useWalletFlow(act);
 const resume=()=>flow.resumePayment(p);
 return <li className="cw-approval"><header><h3>{p.service}</h3><span className="cw-pill cw-pill--wait">{p.statusLabel}</span></header><PaymentDetails p={p}/>
  {note&&<Notice error>{note}</Notice>}
  <p className="cw-note">Waiting for the network. The payment counts as paid only when the network record matches what you approved.</p>
  <div className="cw-actions">{p.canResume&&<Button type="button" disabled={busy} onClick={resume}>Continue in my wallet</Button>}<Button type="button" secondary disabled={busy} onClick={()=>flow.check(p)}>Check again</Button></div></li>;
}

export function WalletApprovals({cw,act,busy}){
 const open=cw.pendingApprovals, inProgress=cw.live?cw.payments.filter(p=>p.status==='executing'):[];
 const recent=cw.payments.filter(p=>!['awaiting_approval','outcome_unknown'].includes(p.status)&&!(cw.live&&p.status==='executing')).slice(0,8);
 return <section className="panel cw-section" aria-labelledby="cw-approvals-title">
  <div className="cw-section-head"><h2 id="cw-approvals-title">Pending approvals</h2>{open.length>0&&<span className="cw-count" aria-label={`${open.length} waiting`}>{open.length}</span>}</div>
  {open.length===0?<p className="cw-empty">Nothing is waiting for you. When a payment needs your approval, it will appear here with every detail.</p>
   :<ul className="cw-approvals">{open.map(p=>p.status==='outcome_unknown'?<Unknown key={p.id} p={p} act={act} busy={busy} cw={cw}/>:<Waiting key={p.id} p={p} act={act} busy={busy}/>)}</ul>}
  {inProgress.length>0&&<ul className="cw-approvals">{inProgress.map(p=><InProgress key={p.id} p={p} act={act} busy={busy}/>)}</ul>}
  {recent.length>0&&<details className="cw-recent"><summary>Recent payments and requests ({recent.length})</summary>
   <ul className="cw-recent-list">{recent.map(p=><li key={p.id}><div><strong>{p.service}</strong><small>{trimUsdc(p.amountUsdc)} USDC · {whenText(p.createdAt)}{p.tool?` · ${p.tool.name}`:''}</small>{p.reason&&<small>{p.reason}</small>}{p.receipt&&<small>Receipt {p.receipt.ref??'recorded'}{p.receipt.simulated?' (simulation, not a blockchain transaction)':''}</small>}</div><span className={'cw-pill '+(p.status==='succeeded'?'cw-pill--ok':'')}>{p.statusLabel}</span></li>)}</ul></details>}
 </section>;
}
