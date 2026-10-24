// Read-only chain evidence. No wallet client, transaction preparation or signing.
import {getContracts,getOrchestratorV3Contract} from '@zkp2p/sdk';
import {createPublicClient,http,decodeEventLog,erc20Abi} from 'viem';
import {base} from 'viem/chains';
import {InputError,TOKEN} from './validation.mjs';
export const ORCHESTRATOR=getOrchestratorV3Contract(8453,'production');
export const ESCROW=getContracts(8453,'production').addresses.escrowV2;
export const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export function hash(v){if(typeof v!=='string'||!/^0x[0-9a-f]{64}$/i.test(v))throw new InputError('Enter a valid transaction hash.');return v;}
export function createReceiptRpc(url){
 const endpoint=new URL(url);
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password)throw Error('An HTTPS Base read endpoint is required.');
 return createPublicClient({chain:base,transport:http(endpoint.href,{timeout:12000,retryCount:0})});
}
export const chain=createReceiptRpc(process.env.BASE_RPC_URL||'https://mainnet.base.org');
export function events(receipt,eventName) {
  return receipt.logs.flatMap(log=>{if(!same(log.address,ORCHESTRATOR.address))return [];try{const d=decodeEventLog({abi:ORCHESTRATOR.abi,data:log.data,topics:log.topics,strict:true});return d.eventName===eventName?[d.args]:[];}catch{return [];}});
}
export function validateDelivery(order,receipt) {
  if(receipt.status!=='success')throw new InputError('The release transaction reverted. Delivery is not confirmed.',409);
  const all=events(receipt,'IntentFulfilled'),a=all.find(x=>same(x.intentHash,order.intentHash));
  if(!a||all.length!==1||!same(a.fundsTransferredTo,order.quote.recipient)||BigInt(a.amount)<BigInt(order.execution.net))throw new InputError('This receipt does not prove the expected delivery.',409);
  const transfers=receipt.logs.flatMap(log=>{if(!same(log.address,TOKEN))return [];try{const d=decodeEventLog({abi:erc20Abi,data:log.data,topics:log.topics,strict:true});return d.eventName==='Transfer'&&same(d.args.to,order.quote.recipient)&&[ORCHESTRATOR.address,ESCROW].some(x=>same(x,d.args.from))?[d.args.value]:[];}catch{return [];}});
  if(transfers.reduce((a,b)=>a+b,0n)!==a.amount)throw new InputError('No matching USDC transfer to the selected agent wallet was found.',409);
  return {amountRaw:String(a.amount),tokenAddress:TOKEN,chainId:8453,recipient:order.quote.recipient,transactionHash:receipt.transactionHash,blockNumber:String(receipt.blockNumber),blockHash:receipt.blockHash};
}
