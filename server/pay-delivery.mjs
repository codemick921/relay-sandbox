import {checkoutRails,currencyCode,supportsFunding,knownCurrency,minimumMinor,methodLabel} from '../shared/fiat.mjs';
import {parseUnits} from 'viem';
import {InputError,TOKEN} from './validation.mjs';
import {chain,ORCHESTRATOR,ESCROW,same,hash,validateDelivery} from './receipts.mjs';

const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v);
export function microUsdc(value){
 if(typeof value!=='string'||!/^\d{1,9}(\.\d{1,6})?$/.test(value))throw new InputError('Peer returned an invalid USDC amount. Delivery is not confirmed.',502);
 return parseUnits(value,6);
}
const issue=message=>{throw new InputError(message,502);};
// Absence during provider/RPC convergence is retryable; conflicting evidence is not.
export class EvidencePendingError extends Error {}
// Settlement observations do not authorise a new payment or change its GBP request.
export function settlementAdjustments(rows){
 if(!Array.isArray(rows)||rows.length>1)issue('Unsupported settlement adjustments.');
 return rows.map(p=>{
  if(p.kind!=='CROSS_CURRENCY'||!Number.isInteger(p.penaltyBps)||p.penaltyBps<0||p.penaltyBps>10000||
    typeof p.originalAmount!=='string'||!/^\d{1,9}\.\d{2}$/.test(p.originalAmount)||
    typeof p.attestedAmount!=='string'||!/^\d{1,9}\.\d{2}$/.test(p.attestedAmount)||
    microUsdc(p.originalAmount)<=0n||microUsdc(p.attestedAmount)<=0n||microUsdc(p.attestedAmount)>microUsdc(p.originalAmount))issue('Unsupported settlement adjustments.');
  return {kind:p.kind,penaltyBps:p.penaltyBps,originalAmount:p.originalAmount,attestedAmount:p.attestedAmount};
 });
}
export function paymentSnapshot(local,remote,rows){
 if(!Array.isArray(rows)||rows.length>100)issue('Peer payment history is incomplete or too large to verify.');
 const ids=new Set(),intents=new Set();
 const payments=rows.map(p=>{
  if(!id(p.id)||ids.has(p.id)||p.orderId!==local.providerOrderId||!supportsFunding(local.quote.platform,currencyCode(local.quote.currency))||p.rail!==local.quote.platform||!knownCurrency(p.currency)||!['CREATED','SETTLED','FAILED','EXPIRED','CANCELLED'].includes(p.status))issue('Peer payment history does not match this order.');
  ids.add(p.id);
  if(!['NONE','CHARGEBACKED'].includes(p.chargebackStatus))issue('Peer returned an unknown chargeback state.');
  const item={id:p.id,status:p.status,chargebackStatus:p.chargebackStatus,currency:p.currency};
  if(p.status!=='SETTLED')return item;
  const adjustments=settlementAdjustments(p.penalties);
  const net=microUsdc(p.netSettledUsdcAmount),fee=microUsdc(p.totalUsdcFeeAmount),signal=p.quote?.signalIntent;
  const intentHash=hash(p.railIdentifier),transactionHash=hash(p.fulfillTransaction);
  if(net<=0n||!signal||!same(signal.toAddress,local.agent.address)||signal.processorName!==local.quote.platform||
    (signal.orchestratorAddress&&!same(signal.orchestratorAddress,ORCHESTRATOR.address))||
    (signal.escrowAddress&&!same(signal.escrowAddress,ESCROW))||
    (p.quote.intentHash&&!same(p.quote.intentHash,intentHash))||!/^\d{1,16}$/.test(signal.amount)||BigInt(signal.amount)<net+fee||
    intents.has(intentHash.toLowerCase()))issue('This payment uses an unsupported or inconsistent settlement route.');
  intents.add(intentHash.toLowerCase());
  const prior=local.verification?.payments?.find(x=>x.id===p.id&&x.intentHash);
  if(prior&&(!same(prior.intentHash,intentHash)||!same(prior.transactionHash,transactionHash)||prior.amountRaw!==String(net)))issue('A settled payment changed. Delivery needs reconciliation.');
  return {...item,intentHash,transactionHash,amountRaw:String(net),feeRaw:String(fee),adjustments};
 });
 // A truncated or stale history cannot erase a previously known settlement.
 for(const prior of local.verification?.payments??[])if(prior.status==='SETTLED'&&!payments.some(p=>p.id===prior.id&&p.status==='SETTLED'))issue('Peer settlement history is incomplete. Retry reconciliation.');
 // FULFILLED is Peer’s decision and may retain a rounding residual. Verify and
 // display the actual net delivered, never equate it to the requested gross.
 const remaining=microUsdc(remote.remainingUsdcAmount);
 if(remaining>microUsdc(remote.requestedUsdcAmount))issue('Invalid remaining order amount.');
 if(remote.status==='FULFILLED'&&!payments.some(p=>p.status==='SETTLED'))throw new EvidencePendingError('Peer settlement history is still arriving.');
 return payments;
}

export async function verifyPayDelivery(local,remote,rows,{rpc=chain,now=Date.now()}={}){
 // Sandbox hashes are synthetic. Never query them or promote them to receipts.
 if(local.source!=='live')throw new InputError('Real delivery verification requires a live order.',409);
 if(remote.bridgeInfo)issue('Bridged settlement is not supported by this Base-only verifier.');
 if(remote.status==='CANCELLED'&&(rows.length||microUsdc(remote.remainingUsdcAmount)!==microUsdc(remote.requestedUsdcAmount)))issue('Cancelled order has payment evidence. Reconciliation is required.');
 const payments=paymentSnapshot(local,remote,rows),settled=payments.filter(p=>p.status==='SETTLED');
 if(settled.length&&await rpc.getChainId()!==8453)issue('The receipt service is not connected to Base.');
 const finalized=settled.length?await rpc.getBlock({blockTag:'finalized'}):null;
 if(settled.length&&(typeof finalized?.number!=='bigint'||finalized.number<0n))throw new EvidencePendingError('Base finality is temporarily unavailable.');
 for(const payment of settled){
  let receipt;
  try{receipt=await rpc.getTransactionReceipt({hash:payment.transactionHash});}
  catch(e){if(e.name==='TransactionReceiptNotFoundError'){payment.deliveryStatus='pending';continue;}throw e;}
  if(!same(receipt.transactionHash,payment.transactionHash)||typeof receipt.blockNumber!=='bigint')issue('Base returned an unexpected receipt.');
  if(receipt.status==='reverted'){payment.deliveryStatus='reverted';continue;}
  const delivery=validateDelivery({intentHash:payment.intentHash,quote:{recipient:local.agent.address},execution:{net:payment.amountRaw}},receipt);
  // Exact net, not a balance change or a loosely matching token transfer.
  if(delivery.amountRaw!==payment.amountRaw)issue('The USDC receipt differs from the settled amount.');
  const canonical=await rpc.getBlock({blockNumber:receipt.blockNumber});
  if(canonical.number!==receipt.blockNumber||!same(canonical.hash,receipt.blockHash)){payment.deliveryStatus='pending';continue;}
  payment.deliveryStatus=finalized.number>=receipt.blockNumber?'finalized':'confirming';
  payment.receipt={...delivery,verifiedAt:new Date(now).toISOString(),finalized:payment.deliveryStatus==='finalized'};
 }
 const total=settled.reduce((n,p)=>n+BigInt(p.amountRaw),0n),arrived=settled.filter(p=>p.deliveryStatus==='finalized').reduce((n,p)=>n+BigInt(p.amountRaw),0n);
 const complete=remote.status==='FULFILLED'&&settled.length>0&&settled.every(p=>p.deliveryStatus==='finalized');
 const status=complete?'checkout_received':settled.some(p=>p.deliveryStatus==='reverted')?'checkout_review':
  settled.some(p=>p.deliveryStatus==='confirming')?'checkout_confirming':settled.some(p=>p.deliveryStatus==='pending')?'checkout_settled':
  remote.status==='CANCELLED'?'checkout_cancelled':remote.status==='PARTIALLY_FULFILLED'||settled.length?'checkout_partial':'checkout_ready';
 return {status,verification:{environment:'LIVE',checkedAt:new Date(now).toISOString(),providerFulfilled:remote.status==='FULFILLED',providerRemainingRaw:String(microUsdc(remote.remainingUsdcAmount)),expectedNetRaw:String(total),receivedRaw:String(arrived),payments},
  delivery:complete?{chainId:8453,tokenAddress:TOKEN,recipient:local.agent.address,amountRaw:String(arrived),finalized:true,verifiedAt:new Date(now).toISOString(),receipts:settled.map(p=>p.receipt)}:null};
}
