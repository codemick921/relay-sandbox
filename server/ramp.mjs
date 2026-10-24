import {verify} from 'node:crypto';
import {decodeEventLog,erc20Abi} from 'viem';
import {InputError,address,pence,TOKEN} from './validation.mjs';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v);
const raw=v=>typeof v==='string'&&/^[1-9]\d{0,17}$/.test(v);
const hash=v=>typeof v==='string'&&/^0x[0-9a-fA-F]{64}$/.test(v);
export const stableJSON=v=>JSON.stringify(sort(v));
function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
export function verifyRampWebhook(bytes,signature,publicKey){
 if(!Buffer.isBuffer(bytes)||bytes.length>262144||typeof signature!=='string'||signature.length>256||!publicKey)throw new InputError('Invalid Ramp notification.',401);
 try{const event=JSON.parse(bytes.toString());if(!verify('sha256',Buffer.from(stableJSON(event)),publicKey,Buffer.from(signature,'base64'))||!['CREATED','RELEASED','RETURNED'].includes(event.type)||!id(event.purchase?.id))throw Error();return event;}catch{throw new InputError('Invalid Ramp notification.',401);}
}
export function rampQuoteRequest(amount){return {cryptoAssetSymbol:'BASE_USDC',fiatCurrency:'GBP',fiatValue:pence(amount)/100,paymentMethodType:'MANUAL_BANK_TRANSFER'};}
export function rampDemoUrl({hostApiKey,hostAppName,hostLogoUrl,recipient,amount,returnUrl}){
 if(!hostApiKey||!hostAppName||new URL(hostLogoUrl).protocol!=='https:'||new URL(returnUrl).protocol!=='https:')throw new InputError('Ramp demo configuration is incomplete.');
 const u=new URL('https://app.demo.rampnetwork.com/');
 for(const [key,value] of Object.entries({hostApiKey,hostAppName,hostLogoUrl,userAddress:address(recipient),enabledFlows:'ONRAMP',defaultFlow:'ONRAMP',enabledCryptoAssets:'BASE_USDC',inAsset:'GBP',outAsset:'BASE_USDC',inAssetValue:String(pence(amount)),selectedCountryCode:'GB',paymentMethodType:'MANUAL_BANK_TRANSFER',finalUrl:returnUrl}))u.searchParams.set(key,value);
 return u.href;
}
// Explicit dependency injection: the application never mounts this network adapter yet.
export function createRampDemoReader({fetcher,enabled=false}){
 if(!enabled||typeof fetcher!=='function')throw new InputError('Ramp external connections are not enabled.',403);
 return {async purchase(purchaseId,purchaseViewToken){
  if(!id(purchaseId)||typeof purchaseViewToken!=='string'||purchaseViewToken.length<8||purchaseViewToken.length>2048)throw new InputError('Invalid Ramp purchase credentials.');
  const u=new URL('https://api.demo.rampnetwork.com/api/host-api/purchase/'+encodeURIComponent(purchaseId));u.searchParams.set('secret',purchaseViewToken);
  try{const r=await fetcher(u.href,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error();const data=await r.json();if(data.id!==purchaseId)throw Error();return data;}catch{throw new InputError('Ramp purchase could not be checked.',503);}
 }};
}
export function checkedRampPurchase(p,expected){
 const valid=['INITIALIZED','PAYMENT_STARTED','PAYMENT_IN_PROGRESS','PAYMENT_FAILED','PAYMENT_EXECUTED','FIAT_SENT','FIAT_RECEIVED','RELEASING','RELEASED','EXPIRED','CANCELLED'];
 if(!p||p.id!==expected.purchaseId||!id(p.id)||!valid.includes(p.status)||p.fiatCurrency!=='GBP'||typeof p.fiatValue!=='number'||pence(String(p.fiatValue))!==expected.pence||!same(p.receiverAddress,expected.recipient)||p.asset?.chain!=='BASE'||!['USDC','BASE_USDC'].includes(p.asset.symbol)||p.asset.decimals!==6||!same(p.asset.address,TOKEN)||!raw(p.cryptoAmount)||p.cryptoAmount!==expected.cryptoAmount||!['MANUAL_BANK_TRANSFER','AUTO_BANK_TRANSFER'].includes(p.paymentMethodType)||!Number.isFinite(p.appliedFee)||p.appliedFee<0||p.appliedFee>p.fiatValue)throw new InputError('Ramp purchase details differ from the saved funding request.',409);
 // Private purchaseViewToken is intentionally excluded from the public projection.
 return {purchaseId:p.id,status:p.status,pence:expected.pence,cryptoAmount:p.cryptoAmount,appliedFee:p.appliedFee,paymentMethodType:p.paymentMethodType,recipient:address(p.receiverAddress).toLowerCase(),transactionHash:hash(p.finalTxHash)?p.finalTxHash:null};
}
export async function verifyRampDelivery(purchase,expected,rpc){
 const p=checkedRampPurchase(purchase,expected),base={provider:'ramp',purchase:p,delivery:null};
 if(p.status!=='RELEASED')return {...base,status:['CANCELLED','EXPIRED','PAYMENT_FAILED'].includes(p.status)?'ended':'waiting'};
 if(!p.transactionHash)return {...base,status:'waiting'};
 if(await rpc.getChainId()!==8453)throw new InputError('Unexpected receipt network.',409);
 const r=await rpc.getTransactionReceipt({hash:p.transactionHash});
 if(r.status!=='success'||!same(r.transactionHash,p.transactionHash)||!hash(r.blockHash)||typeof r.blockNumber!=='bigint')throw new InputError('Ramp transfer is not a successful Base receipt.',409);
 let received=0n;
 for(const log of r.logs){if(!same(log.address,TOKEN))continue;try{const e=decodeEventLog({abi:erc20Abi,eventName:'Transfer',data:log.data,topics:log.topics,strict:true});if(e.eventName==='Transfer'&&same(e.args.to,p.recipient))received+=e.args.value;}catch{/* Not a valid native-USDC transfer. */}}
 if(received!==BigInt(p.cryptoAmount))throw new InputError('USDC receipt amount or destination differs.',409);
 const block=await rpc.getBlock({blockNumber:r.blockNumber}),final=await rpc.getBlock({blockTag:'finalized'});
 if(!same(block.hash,r.blockHash)||block.number!==r.blockNumber)throw new InputError('Receipt block is no longer canonical.',409);
 if(final.number<r.blockNumber)return {...base,status:'confirming'};
 return {...base,status:'received',delivery:{transactionHash:r.transactionHash,blockHash:r.blockHash,blockNumber:String(r.blockNumber),amountRaw:String(received),chainId:8453,tokenAddress:TOKEN,recipient:p.recipient,finalized:true}};
}
