import {Zkp2pClient,getContracts,getOrchestratorV3Contract,getPaymentMethodsCatalog,apiGetPayeeDetails} from '@zkp2p/sdk';
import {createPublicClient,createWalletClient,http,custom,decodeEventLog,decodeFunctionData,erc20Abi,keccak256,toHex,zeroAddress} from 'viem';
import {base} from 'viem/chains';
import {InputError,TOKEN,address} from './peer.mjs';

const deployment=getContracts(8453,'production');
export const ORCHESTRATOR=getOrchestratorV3Contract(8453,'production');
export const ESCROW=deployment.addresses.escrowV2;
const RPC=process.env.BASE_RPC_URL||'https://mainnet.base.org';
export const chain=createPublicClient({chain:base,transport:http(RPC,{timeout:12000,retryCount:0})});
const deny=custom({request:async()=>{throw Error('Server signing is disabled.');}});
export const makeClient=account=>new Zkp2pClient({walletClient:createWalletClient({account,chain:base,transport:deny}),rpcTransport:http(RPC,{timeout:12000,retryCount:0}),chainId:8453,runtimeEnv:'production',baseApiUrl:'https://api.zkp2p.xyz',timeouts:{api:15000}});
export const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const uint=v=>typeof v==='string'&&/^\d+$/.test(v);
export function hash(v) {if(typeof v!=='string'||!/^0x[0-9a-f]{64}$/i.test(v))throw new InputError('Enter a valid transaction hash.');return v;}
const currency=keccak256(toHex('GBP'));
export function executionFor(raw,quote) {
  const i=raw?.intent, net=raw?.tokenAmount, amount=raw?.signalIntentAmount??i?.amount;
  if(!i || !same(i.escrowAddress,ESCROW) || (i.orchestratorAddress&&!same(i.orchestratorAddress,ORCHESTRATOR.address)) || String(i.chainId)!=='8453' || !same(i.toAddress,quote.recipient) || i.processorName!==quote.platform || !['GBP',currency].some(v=>same(v,i.fiatCurrencyCode))) throw new InputError('This offer cannot be reserved on the supported Peer deployment.',409);
  if(!uint(amount)||!uint(net)||BigInt(amount)<BigInt(net)||BigInt(net)<=0n || !uint(raw.conversionRate)||BigInt(raw.conversionRate)<=0n || !/^\d+$/.test(String(i.depositId)) || (typeof i.depositId==='number'&&!Number.isSafeInteger(i.depositId))) throw new InputError('Peer supplied incomplete order amounts.',502);
  if(raw.disputeProtectionRequiresStake!==false)throw new InputError('This offer requires staking or has unknown staking requirements. Choose another offer.',409);
  const recipient=raw.maker?.offchainId;
  if(typeof recipient!=='string'||recipient.length>256||!recipient.trim()||/[\x00-\x1f]/.test(recipient))throw new InputError('Peer supplied an invalid seller identifier.',502);
  // Different platforms use different identity mappings. Resolve via Peer's
  // documented hash-keyed maker endpoint instead of inventing a hash formula.
  hash(i.payeeDetails);
  const rate=BigInt(raw.conversionRate);
  // Quote is exact fiat; refuse unexpected debit amounts, allowing only one penny rounding.
  const calculated=(BigInt(amount)*rate+10n**18n-1n)/10n**18n;
  const expected=BigInt(quote.pence)*10000n;
  if(calculated>expected || expected-calculated>10000n)throw new InputError('The reservation amount differs from the reviewed GBP quote.',409);
  const feeBps=(raw.serviceFeeBps??0)+(raw.takerReferralFeeBps??0);
  if(!Number.isSafeInteger(feeBps)||feeBps<0||feeBps>=10000)throw new InputError('Peer supplied invalid fee terms.',502);
  return {params:{depositId:String(i.depositId),amount,toAddress:address(quote.recipient),processorName:quote.platform,payeeDetails:i.payeeDetails,fiatCurrencyCode:'GBP',conversionRate:raw.conversionRate,escrowAddress:ESCROW,orchestratorAddress:ORCHESTRATOR.address},net,recipient,feeRate:String(BigInt(feeBps)*10n**14n),paymentMethod:getPaymentMethodsCatalog(8453,'production')[quote.platform].paymentMethodHash};
}
export function validatePayee(execution,response,deposit) {
  const maker=response?.responseObject,p=execution.params;
  const method=deposit?.paymentMethods?.find(m=>same(m.paymentMethod,execution.paymentMethod));
  if(response?.success!==true||!maker||maker.processorName!==p.processorName||maker.offchainId!==execution.recipient||!same(maker.hashedOnchainId,p.payeeDetails)||!same(method?.verificationData?.payeeDetails,p.payeeDetails)||!same(deposit?.deposit?.token,TOKEN))throw new InputError('The seller identity or token does not match the Peer deposit.',502);
}
export function validatePrepared(prepared,execution) {
  if(prepared.chainId!==8453||!same(prepared.to,ORCHESTRATOR.address)||BigInt(prepared.value??0)!==0n)throw new InputError('Peer prepared an unexpected transaction.',502);
  const {functionName,args}=decodeFunctionData({abi:ORCHESTRATOR.abi,data:prepared.data});
  const a=args?.[0],p=execution.params;
  if(functionName!=='signalIntent'||!a||!same(a.to,p.toAddress)||!same(a.escrow,p.escrowAddress)||String(a.depositId)!==p.depositId||String(a.amount)!==p.amount||String(a.conversionRate)!==p.conversionRate||!same(a.paymentMethod,execution.paymentMethod)||!same(a.fiatCurrency,currency)||!same(a.postIntentHook,zeroAddress)||a.data!=='0x')throw new InputError('The transaction does not match the selected offer.',502);
  // Peer returns its quoted service fee as referralFees in the signed calldata.
  // Accept only the exact quoted rate and no deduction beyond the quoted net.
  const fees=a.referralFees??[];
  const rate=fees.reduce((sum,f)=>sum+f.fee,0n);
  if(rate!==BigInt(execution.feeRate)||fees.some(f=>same(f.recipient,zeroAddress)||f.fee<0n)||BigInt(p.amount)*rate/10n**18n>BigInt(p.amount)-BigInt(execution.net))throw new InputError('The prepared fees exceed or differ from the reviewed quote.',502);
  const expires=Number(a.signatureExpiration)*1000;
  if(!Number.isFinite(expires)||expires<=Date.now())throw new InputError('The authorisation expired. Search again.',409);
  return {to:prepared.to,data:prepared.data,value:'0',chainId:8453,expiresAt:new Date(expires).toISOString()};
}
export async function prepareOrder(quote,raw) {
  const execution=executionFor(raw,quote);
  const sdk=makeClient(quote.payer);
  const [maker,deposit]=await Promise.all([apiGetPayeeDetails({processorName:quote.platform,hashedOnchainId:execution.params.payeeDetails},'https://api.zkp2p.xyz',15000),sdk.getDeposit(execution.params.depositId)]);
  validatePayee(execution,maker,deposit);
  const tx=validatePrepared(await sdk.signalIntent.prepare(execution.params),execution);
  // Read contract state, not an assumed reservation lifetime.
  const period=await chain.readContract({address:ESCROW,abi:deployment.abis.escrow,functionName:'intentExpirationPeriod'});
  if(period<=0n||period>604800n)throw new InputError('Peer returned an unsupported reservation lifetime.',502);
  return {execution,tx,expirationSeconds:Number(period)};
}
function events(receipt,eventName) {
  return receipt.logs.flatMap(log=>{if(!same(log.address,ORCHESTRATOR.address))return [];try{const d=decodeEventLog({abi:ORCHESTRATOR.abi,data:log.data,topics:log.topics,strict:true});return d.eventName===eventName?[d.args]:[];}catch{return [];}});
}
export function validateReservation(order,receipt,transaction) {
  if(receipt.status!=='success')throw new InputError('The reservation transaction reverted. No payment should be made.',409);
  if(!same(transaction.from,order.quote.payer)||!same(transaction.to,order.tx.to)||transaction.input!==order.tx.data||BigInt(transaction.value)!==0n)throw new InputError('This transaction does not belong to the selected order.',409);
  const matches=events(receipt,'IntentSignaled');
  const p=order.execution.params,a=matches[0];
  if(matches.length!==1||!same(a.owner,order.quote.payer)||!same(a.to,order.quote.recipient)||!same(a.escrow,p.escrowAddress)||String(a.depositId)!==p.depositId||String(a.amount)!==p.amount||String(a.conversionRate)!==p.conversionRate||!same(a.paymentMethod,order.execution.paymentMethod)||!same(a.fiatCurrency,currency))throw new InputError('The confirmed reservation does not match this order.',409);
  return {intentHash:a.intentHash,reservationBlock:String(receipt.blockNumber),reservationBlockHash:receipt.blockHash,expiresAt:new Date((Number(a.timestamp)+order.expirationSeconds)*1000).toISOString()};
}
export function validateDelivery(order,receipt) {
  if(receipt.status!=='success')throw new InputError('The release transaction reverted. Delivery is not confirmed.',409);
  const all=events(receipt,'IntentFulfilled'),a=all.find(x=>same(x.intentHash,order.intentHash));
  if(!a||all.length!==1||!same(a.fundsTransferredTo,order.quote.recipient)||BigInt(a.amount)<BigInt(order.execution.net))throw new InputError('This receipt does not prove the expected delivery.',409);
  const transfers=receipt.logs.flatMap(log=>{if(!same(log.address,TOKEN))return [];try{const d=decodeEventLog({abi:erc20Abi,data:log.data,topics:log.topics,strict:true});return d.eventName==='Transfer'&&same(d.args.to,order.quote.recipient)&&[ORCHESTRATOR.address,ESCROW].some(x=>same(x,d.args.from))?[d.args.value]:[];}catch{return [];}});
  if(transfers.reduce((a,b)=>a+b,0n)!==a.amount)throw new InputError('No matching USDC transfer to the selected agent wallet was found.',409);
  return {amountRaw:String(a.amount),tokenAddress:TOKEN,chainId:8453,recipient:order.quote.recipient,transactionHash:receipt.transactionHash,blockNumber:String(receipt.blockNumber),blockHash:receipt.blockHash};
}
export async function reconcile(order,{rpc=chain,now=Date.now()}={}) {
  if(!order.reservationTx)return {status:order.status};
  let reservation;
  try{reservation=await rpc.getTransactionReceipt({hash:order.reservationTx});}catch(e){if(e.name==='TransactionReceiptNotFoundError')return {status:'reservation_pending'};throw e;}
  if(reservation.status==='reverted')return {status:'reservation_failed'};
  const tx=await rpc.getTransaction({hash:order.reservationTx});
  const bound=validateReservation(order,reservation,tx);
  const canonical=await rpc.getBlock({blockNumber:reservation.blockNumber});
  if(!same(canonical.hash,reservation.blockHash))return {status:'reservation_pending'};
  const head=await rpc.getBlockNumber();
  if(head<reservation.blockNumber+2n)return {...bound,status:'reservation_pending'};
  const current={...order,...bound};
  // Scan event logs in bounded batches; cursor and candidate hash persist for resumption.
  let releaseHash=order.releaseTx;
  let scannedThrough=order.scannedThrough;
  if(!releaseHash){
    let start=scannedThrough?BigInt(scannedThrough)+1n:reservation.blockNumber;
    // Always overlap recent blocks to recover a shallow reorganisation.
    if(start>reservation.blockNumber+20n)start-=20n;
    for(let n=0;n<4&&start<=head;n++){
      const end=start+1999n<head?start+1999n:head;
      const logs=await rpc.getLogs({address:ORCHESTRATOR.address,event:ORCHESTRATOR.abi.find(x=>x.type==='event'&&x.name==='IntentFulfilled'),args:{intentHash:bound.intentHash},fromBlock:start,toBlock:end});
      scannedThrough=String(end);
      if(logs.length){releaseHash=logs[0].transactionHash;break;}start=end+1n;
    }
  }
  const common={...bound,scannedThrough,lastCheckedAt:new Date(now).toISOString()};
  if(releaseHash){
    let receipt;try{receipt=await rpc.getTransactionReceipt({hash:releaseHash});}catch(e){if(e.name==='TransactionReceiptNotFoundError')return {...common,releaseTx:releaseHash,status:'release_pending'};throw e;}
    if(receipt.status==='reverted')return {...common,releaseTx:releaseHash,status:'release_failed'};
    const delivery=validateDelivery(current,receipt);
    const block=await rpc.getBlock({blockNumber:receipt.blockNumber});
    if(!same(block.hash,receipt.blockHash))return {...common,status:'release_pending'};
    const finalized=await rpc.getBlock({blockTag:'finalized'});
    return {...common,releaseTx:releaseHash,delivery,status:finalized.number>=receipt.blockNumber?'received':'confirming'};
  }
  // A timeout never proves that a user's bank payment failed or was refunded.
  return {...common,status:now>=Date.parse(bound.expiresAt)?'expired_unresolved':order.releaseAttempt?'release_unknown':'awaiting_payment'};
}
export function publicOrder(order) {
  if(order.kind!=='native')return order;
  const {execution,...rest}=order;
  const active=['awaiting_payment','release_pending','release_failed','confirming','received','expired_unresolved'].includes(order.status);
  return {...rest,payment:active?{recipient:execution.recipient,currency:'GBP',amount:(order.quote.pence/100).toFixed(2)}:undefined};
}
// Fixed read-only JSON-RPC proxy for the browser SDK. No arbitrary URLs or send methods.
const READ_METHODS=new Set(['eth_chainId','eth_blockNumber','eth_call','eth_getBlockByNumber','eth_getBlockByHash','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getCode','eth_getLogs','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory','eth_getBalance','eth_getTransactionCount']);
export async function proxyRpc(body) {
  if(!body||Array.isArray(body)||body.jsonrpc!=='2.0'||!READ_METHODS.has(body.method)||!Array.isArray(body.params))throw new InputError('Only supported Base read requests are allowed.',400);
  const response=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new InputError('Base read service is unavailable.',502);
  return response.json();
}
