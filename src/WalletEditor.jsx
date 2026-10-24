import React,{useState} from 'react';
import {Modal,Notice,Field,Check,Button} from './ui';
export default function WalletEditor({state,agent,act,busy,error,onClose}){
 const [name,setName]=useState(agent?.name??'Research assistant'),[address,setAddress]=useState(agent?.address??''),[own,setOwn]=useState(false),[password,setPassword]=useState('');
 const customer=!!state.account,edited=!!agent;
 return <Modal title={edited?'Edit saved wallet':'Add your agent wallet'} onClose={busy?()=>{}:onClose}>
  <Notice>{edited?'Changes apply to future requests only. Existing drafts, payments and receipts keep their original destination. Cancel an unsubmitted draft and review a new one to use the updated wallet.':'Save a Base USDC destination. This does not verify wallet ownership or give Relay permission to spend.'}</Notice>
  {error&&<Notice error>{error}</Notice>}
  <form onSubmit={async e=>{e.preventDefault();const result=await act(edited?'agents/update':'agents',{name,address,own,network:'base',...customer?{currentPassword:password}:{},...edited?{id:agent.id,expectedAddress:agent.address,expectedName:agent.name}:{}});setPassword('');if(result)onClose();}}>
   <Field label="Agent name"><input required minLength={2} maxLength={60} disabled={busy} value={name} onChange={e=>{setName(e.target.value);setOwn(false);}}/></Field>
   <div className="two-fields"><Field label="Network"><input readOnly value="Base"/></Field><Field label="Token"><input readOnly value="USDC"/></Field></div>
   {edited&&<section className="wallet-before"><strong>Currently saved address</strong><code className="checkout-address">{agent.address}</code></section>}
   <Field label={edited?'New receiving address':'Wallet address'}><input className="mono" required disabled={busy} pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" value={address} onChange={e=>{setAddress(e.target.value.trim());setOwn(false);}}/></Field>
   {!customer&&<button type="button" className="text-button" onClick={()=>setAddress('0x1111111111111111111111111111111111111111')}>Use a practice address</button>}
   <Check checked={own} disabled={busy} onChange={e=>setOwn(e.target.checked)} required>I have checked the full address. This is my receiving wallet for USDC on Base.</Check>
   {customer&&<Field label="Current Relay password" hint="Required for this change. This does not verify ownership of the wallet."><input required type="password" autoComplete="current-password" maxLength={128} disabled={busy} value={password} onChange={e=>setPassword(e.target.value)}/></Field>}
   <Button className="full" disabled={busy||!own}>{busy?'Saving…':edited?'Save wallet changes':'Save agent wallet'}</Button>
  </form>
 </Modal>;
}
