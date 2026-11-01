import {walletAddressCheck} from '../shared/wallet-address.mjs';
import './wallet-editor.css';
import FundingTerms from './FundingTerms';
import React,{useState} from 'react';
import {Modal,Notice,Field,Check,Button,Icon} from './ui';
export default function WalletEditor({state,agent,act,busy,error,onClose,onSaved}){
 const [name,setName]=useState(agent?.name??'Research assistant'),[address,setAddress]=useState(agent?.address??''),[own,setOwn]=useState(false),[password,setPassword]=useState('');
 const customer=!!state.account,edited=!!agent,check=walletAddressCheck(address);
 const canSave=check.valid&&own&&name.trim().length>=2&&name.trim().length<=60&&(!customer||password.length>0)&&!busy;
 return <Modal className="agent-editor" title={edited?'Edit saved wallet':'Add your agentic wallet'} onClose={busy?()=>{}:onClose}>
  <Notice>{edited?'Changes apply to future requests only. Existing drafts, payments and receipts keep their original destination. Cancel an unsubmitted draft and review a new one to use the updated wallet.':'Save the address that should receive USDC on the Base network. Eupova does not verify who owns it and cannot spend from it.'}</Notice>
  <FundingTerms/>
  {error&&<Notice error>{error}</Notice>}
  <form onSubmit={async e=>{e.preventDefault();if(!canSave)return;const result=await act(edited?'agents/update':'agents',{name,address,own,network:'base',...customer?{currentPassword:password}:{},...edited?{id:agent.id,expectedAddress:agent.address,expectedName:agent.name}:{}});setPassword('');if(result){if(onSaved)onSaved(result);else onClose();}}}>
   <Field label="Wallet name"><input required minLength={2} maxLength={60} disabled={busy} value={name} onChange={e=>{setName(e.target.value);setOwn(false);}}/></Field>
   <div className="two-fields"><Field label="Network"><input readOnly value="Base"/></Field><Field label="Currency"><input readOnly value="USDC"/></Field></div>
   {edited&&<section className="wallet-before"><strong>Currently saved address</strong><code className="checkout-address">{agent.address}</code></section>}
   <Field label={edited?'New receiving address':'Wallet address'}><input className="mono" required disabled={busy} pattern="0x[0-9a-fA-F]{40}" aria-describedby="wallet-address-status wallet-network-help" aria-invalid={address&&!check.valid?true:undefined} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="0x…" value={address} onChange={e=>{setAddress(e.target.value.trim());setOwn(false);}}/></Field>
   <div id="wallet-address-status" className={'wallet-address-status '+(check.valid?'is-valid':address?'is-invalid':'')} role="status" aria-live="polite"><Icon name={check.valid?'check':'info'} size={20}/><span>{check.message}</span></div>
   <div id="wallet-network-help" className="wallet-network-help"><strong>Check Base in your receiving wallet</strong><p>In your wallet’s Receive or Deposit screen, select USDC and the Base network, then copy the address shown there.</p><p>A 0x address can be used on several networks. This check cannot confirm Base support or who controls the wallet. For an exchange or smart wallet, confirm that it accepts USDC on Base at this address.</p></div>
   {!customer&&<button type="button" className="text-button" onClick={()=>{setAddress('0x1111111111111111111111111111111111111111');setOwn(false);}}>Use a practice address</button>}
   <Check checked={own} disabled={busy||!check.valid} onChange={e=>setOwn(e.target.checked)} required>I have checked in my wallet or exchange that this address can receive USDC on Base, and I have checked the full address.</Check>
   {customer&&<Field label="Current Eupova password" hint="Required for this change. This does not verify ownership of the wallet."><input required type="password" autoComplete="current-password" maxLength={128} disabled={busy} value={password} onChange={e=>setPassword(e.target.value)}/></Field>}
   <Button className="full" disabled={!canSave}>{busy?'Saving…':edited?'Save wallet changes':'Save agentic wallet'}</Button>
  </form>
 </Modal>;
}
