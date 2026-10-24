import {parseUnits} from 'viem';
import {InputError,address,pence,TOKEN} from './validation.mjs';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const sameUsdc=(a,b)=>typeof a==='string'&&typeof b==='string'&&/^\d{1,5}(\.\d{1,6})?$/.test(a)&&/^\d{1,5}(\.\d{1,6})?$/.test(b)&&parseUnits(a,6)===parseUnits(b,6);
export function checkoutRequest(order,origin){
 return {requestedFiatAmount:(order.quote.pence/100).toFixed(2),requestedFiatCurrency:'GBP',
  destinationAddress:address(order.agent.address),destinationToken:'USDC',destinationChainId:8453,
  feePayer:'MERCHANT',enabledRails:['wise'],dynamicOrdersEnabled:false,
  idempotencyKey:order.id,successUrl:origin+'/?checkout='+encodeURIComponent(order.id),
  notes:{relayOrderId:order.id}};
}
export function validateCheckout(remote,local,merchantId){
 const original=remote?.metadata;
 const fiat=remote?.requestedFiat??(original?.requestAmountInputMode==='fiat'?{amount:original.requestedFiatAmount,currency:original.requestedFiatCurrency}:null);
 // Hosted reads expose requestedFiat; current creation responses carry the same
 // original inputs in metadata. Check both when present, and reject resized orders.
 const metadataMatches=!original?.requestAmountInputMode||(original.requestAmountInputMode==='fiat'&&original.requestedFiatCurrency==='GBP'&&pence(original.requestedFiatAmount)===local.quote.pence&&sameUsdc(original.requestedUsdcAmountAtCreation,remote.requestedUsdcAmount));
 if(!remote||typeof remote.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(remote.id)||
   (local.providerOrderId&&remote.id!==local.providerOrderId)||remote.merchantId!==merchantId||
   !same(remote.destinationAddress,local.agent.address)||String(remote.destinationChainId)!=='8453'||
   !(remote.destinationToken==='USDC'||same(remote.destinationToken,TOKEN))||
   remote.feePayer!=='MERCHANT'||remote.amountMode!=='FIXED'||
   remote.enabledRails?.length!==1||remote.enabledRails[0]!=='wise'||
   fiat?.currency!=='GBP'||pence(fiat.amount)!==local.quote.pence||!metadataMatches||
   remote.notes?.relayOrderId!==local.id||!['CREATED','PARTIALLY_FULFILLED','FULFILLED','CANCELLED'].includes(remote.status)){
  throw new InputError('Peer checkout details do not match this order. Keep this order for reconciliation.',502);
 }
 return remote;
}

export {sameUsdc};
