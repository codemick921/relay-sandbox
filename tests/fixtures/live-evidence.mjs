import {encodeEventTopics,encodeAbiParameters,erc20Abi,parseUnits} from 'viem';
import {ORCHESTRATOR,ESCROW} from '../../server/receipts.mjs';
import {TOKEN} from '../../server/validation.mjs';
const recipient='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222';
const intent='0x'+'ab'.repeat(32),tx='0x'+'cd'.repeat(32),blockHash='0x'+'ef'.repeat(32);
const now=1792857600000,secret='fixture-only-secret',config={secret,merchantId:'merchant',environment:'LIVE',now};
export const local=()=>({id:'relay-order',kind:'checkout',providerOrderId:'peer-order',merchantId:'merchant',source:'live',status:'checkout_ready',agent:{id:'agent',name:'Example agent',address:recipient},quote:{pence:2500,platform:'wise'},events:[]});
export const remote=()=>({id:'peer-order',merchantId:'merchant',status:'FULFILLED',requestedUsdcAmount:'12.5',remainingUsdcAmount:'0',amountMode:'FIXED',destinationAddress:recipient,destinationToken:'USDC',destinationChainId:'8453',feePayer:'MERCHANT',enabledRails:['wise'],requestedFiat:{amount:'25',currency:'GBP'},notes:{relayOrderId:'relay-order'},chargebackStatus:'NONE'});
export const payment=()=>({id:'payment-1',orderId:'peer-order',status:'SETTLED',rail:'wise',currency:'GBP',chargebackStatus:'NONE',penalties:[],netSettledUsdcAmount:'12',totalUsdcFeeAmount:'0.5',railIdentifier:intent,fulfillTransaction:tx,quote:{intentHash:intent,signalIntent:{processorName:'wise',toAddress:recipient,orchestratorAddress:ORCHESTRATOR.address,escrowAddress:ESCROW,amount:'12500000'}}});
function log(abi,eventName,args,address){const event=abi.find(x=>x.type==='event'&&x.name===eventName);return {address,topics:encodeEventTopics({abi:[event],eventName,args}),data:encodeAbiParameters(event.inputs.filter(i=>!i.indexed),event.inputs.filter(i=>!i.indexed).map(i=>args[i.name]))};}
export function receipt(p=payment()){
 const destination=p.quote?.signalIntent?.toAddress??recipient,amount=parseUnits(p.netSettledUsdcAmount,6);
 return {status:'success',transactionHash:p.fulfillTransaction,blockNumber:120n,blockHash,logs:[log(ORCHESTRATOR.abi,'IntentFulfilled',{intentHash:p.railIdentifier,fundsTransferredTo:destination,amount,isManualRelease:false},ORCHESTRATOR.address),log(erc20Abi,'Transfer',{from:ORCHESTRATOR.address,to:destination,value:amount},TOKEN)]};
}
export const rpc=(overrides={})=>({getChainId:async()=>8453,getTransactionReceipt:async()=>receipt(),getBlock:async({blockTag})=>({hash:blockHash,number:blockTag==='finalized'?120n:120n}),...overrides});
