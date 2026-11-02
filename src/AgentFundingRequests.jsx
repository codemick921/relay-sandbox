import React,{useState,useEffect} from 'react';
import {Button,Icon,Notice,Modal,Field,Check} from './ui';
import {requestState,targetRaw,targetUnits} from '../shared/funding-request.mjs';
import {requestTargetEvidence} from './request-target.mjs';
import DestinationGuide from './DestinationGuide';
import './agent-funding-requests.css';
const labels={open:'Ready to review',expired:'Expired',cancelled:'Cancelled',wallet_changed:'Wallet changed',linked:'Funding prepared'};
const stamp=v=>new Date(v).toLocaleString('en-GB');
export function RequestTarget({request,order,draft}){
 const [now,setNow]=useState(Date.now());useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 if(!request)return null;
 const {pair,comparison,arrived}=requestTargetEvidence(request,order,draft,now)??{};
 return <section className="request-target"><span>Agent’s funding target</span><strong>{targetUnits(request.targetRaw)} <small>USDC on Base</small></strong><p>{request.purpose}</p><p className="fine-print">{comparison?`${arrived?'Verified arrival':pair.kind==='estimate'?'Selected offer estimate':'Recorded settlement'}: ${pair.receive}. ${comparison.met?'Meets the target.':`${comparison.shortfall} USDC below the target.`}${!arrived?' Wallet arrival is not confirmed.':''}`:'The fiat amount is chosen separately. Compare the final USDC amount in Peer with this target before paying.'}</p></section>;
}
export default function AgentFundingRequests({state,open,act,busy,error}){
 const [filter,setFilter]=useState('open'),[now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const requests=state.agentFundingRequests??[],status=r=>requestState(r,state.agents.find(a=>a.id===r.agent.id),now),rows=requests.filter(r=>filter==='all'||['open','wallet_changed'].includes(status(r)));
 return <section className="panel agent-requests" aria-label="Agent funding requests"><div className="request-section-head"><div><p className="request-eyebrow">Plan your agent’s next task</p><h3>Funding requests</h3><p>Save what your agent needs. Review the details before you choose to pay.</p></div><Button disabled={busy||!state.agents.length} onClick={()=>open('agent-request-new')}><Icon name="plus" size={18}/>New funding request</Button></div>
  <div className="request-filters" role="group" aria-label="Request filters">{[['open','To review'],['all','All requests']].map(([key,label])=><Button key={key} secondary aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label}</Button>)}</div>
  {error&&<Notice error>{error}</Notice>}
  {!rows.length?<div className="requests-empty"><Icon name="robot" size={32}/><h4>{filter==='all'?'No funding requests yet':'Nothing waiting for review'}</h4><p>{state.agents.length?'Create a request with a purpose, USDC target and receiving wallet.':'Add a saved wallet in My agents to create your first request.'}</p></div>:<div className="request-card-grid">{rows.map(r=><article className="agent-request-card" key={r.id}><div className="request-card-heading"><span className="request-card-icon"><Icon name="robot"/></span><div><h4>{r.agent.name}</h4><span>{labels[status(r)]}</span></div></div><strong className="request-target-amount">{targetUnits(r.targetRaw)} <small>USDC</small></strong><p>{r.purpose}</p><small>{r.draftId?'Prepared from this request':'Review by '+stamp(r.expiresAt)}</small><Button secondary onClick={()=>open('agent-request',r.id)}>Review details<Icon name="arrow" size={18}/></Button></article>)}</div>}
  <p className="fine-print request-footer">Requests stay in your account. Creating one does not send money, connect a wallet or give an agent permission to spend.</p>
 </section>;
}
export function NewAgentRequest({state,act,busy,error,onClose,open}){
 const [agentId,setAgentId]=useState(state.agents[0]?.id??''),[purpose,setPurpose]=useState(''),[target,setTarget]=useState(''),[hours,setHours]=useState(24),[confirm,setConfirm]=useState(false),[key]=useState(()=>crypto.randomUUID()),[saving,setSaving]=useState(false);
 const agent=state.agents.find(a=>a.id===agentId),locked=busy||saving;
 return <Modal title="New funding request" onClose={locked?()=>{}:onClose} className="agent-request-modal"><p>Set a USDC target for a task. You’ll choose the payment amount and review the offer separately.</p>{error&&<Notice error>{error}</Notice>}<form onSubmit={async e=>{e.preventDefault();if(locked||!confirm||!targetRaw(target))return;setSaving(true);try{const saved=await act('agent-funding-requests/create',{requestKey:key,agentId,purpose,targetUsdc:target,expiresInHours:hours,confirmDestination:confirm});if(saved){const created=saved.agentFundingRequests?.find(r=>!state.agentFundingRequests?.some(old=>old.id===r.id));if(created)open('agent-request',created.id);else onClose();}}finally{setSaving(false);}}}>
  <Field label="Agentic wallet"><select value={agentId} disabled={locked} onChange={e=>{setAgentId(e.target.value);setConfirm(false);}}>{state.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
  <Field label="What is the funding for?"><input required minLength={3} maxLength={240} disabled={locked} value={purpose} onChange={e=>setPurpose(e.target.value)} placeholder="For example, this week’s research tasks"/></Field>
  <Field label="USDC your agent needs" hint="A target after fees, not a price quote or a guaranteed amount."><div className="money-input"><span>USDC</span><input required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,6})?" disabled={locked} value={target} onChange={e=>setTarget(e.target.value)} placeholder="25"/></div></Field>
  <Field label="Review within"><select disabled={locked} value={hours} onChange={e=>setHours(Number(e.target.value))}><option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option></select></Field>
  {agent&&<code className="checkout-address">{agent.address}</code>}<DestinationGuide/>
  <Check checked={confirm} disabled={locked} onChange={e=>setConfirm(e.target.checked)}>I checked the receiving platform’s instructions. This address accepts USDC on Base for my account.</Check>
  <Button type="submit" className="full spaced" disabled={locked||!confirm||!targetRaw(target)||purpose.trim().length<3||!agent}>{locked?'Saving…':'Save request'}</Button><p className="fine-print">No payment or Peer checkout is created.</p>
 </form></Modal>;
}
export function AgentRequestDetail({state,id,open,act,busy,error,onClose}){
 const [now,setNow]=useState(Date.now());useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const request=state.agentFundingRequests?.find(r=>r.id===id);
 if(!request)return <Modal title="Funding request" onClose={onClose}><Notice>This request is not available in your account.</Notice></Modal>;
 const current=state.agents.find(a=>a.id===request.agent.id),status=requestState(request,current,now),draft=state.fundingDrafts?.find(d=>d.id===request.draftId),order=state.orders?.find(o=>o.id===request.draftId);
 return <Modal title="Review funding request" onClose={onClose} className="agent-request-modal">{error&&<Notice error>{error}</Notice>}<div className="request-detail-heading"><span className="request-card-icon"><Icon name="robot" size={28}/></span><div><h3>{request.agent.name}</h3><p>{labels[status]}</p></div></div><RequestTarget {...{request,draft,order}}/>
  <dl className="details"><div><dt>Destination</dt><dd>USDC on Base</dd></div><div><dt>Created</dt><dd>{stamp(request.createdAt)}</dd></div><div><dt>Review deadline</dt><dd>{stamp(request.expiresAt)}</dd></div><div><dt>Requested by</dt><dd>You · saved in this account</dd></div></dl><code className="checkout-address">{request.agent.address}</code><DestinationGuide/>
  {status==='open'?<><Button className="full spaced" disabled={busy} onClick={()=>open('live-fund',request.agent.id,{fundingRequestId:request.id,amount:''})}>Choose payment amount<Icon name="arrow" size={18}/></Button><Button secondary className="full spaced" disabled={busy} onClick={()=>act('agent-funding-requests/cancel',{id:request.id})}>Cancel request</Button></>:status==='linked'?<><Notice>The funding draft stays linked to this request. Open it to check whether a payment has started.</Notice><Button className="full spaced" disabled={busy||!draft} onClick={()=>open('funding-draft',request.draftId)}>View funding progress</Button></>:<Notice>{status==='wallet_changed'?'The saved wallet changed. Create a new request to review its current receiving details.':status==='expired'?'This request expired before funding was prepared. Create a new request if your agent still needs funds.':'This request was cancelled. No payment was created by cancelling it.'}</Notice>}
  <p className="fine-print request-footer">The review deadline stops a new Peer checkout from being created for this request. It does not cancel a payment already started. A wallet transfer does not prove that a separate platform credited your account.</p>
 </Modal>;
}
