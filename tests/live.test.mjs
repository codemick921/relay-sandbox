import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {encodeEventTopics,encodeAbiParameters,encodeFunctionData,erc20Abi,keccak256,toHex,zeroAddress} from 'viem';
import {getPaymentMethodsCatalog} from '@zkp2p/sdk';
import {executionFor,validatePayee,validatePrepared,validateReservation,validateDelivery,reconcile,ORCHESTRATOR,ESCROW,publicOrder,proxyRpc} from '../server/live.mjs';
import {TOKEN,getOffers} from '../server/peer.mjs';
import {createApp} from '../server/index.mjs';
import {matchingPayment,buildProof,extensionSupported} from '../shared/payment.mjs';
const payer='0x1111111111111111111111111111111111111111',recipient='0x2222222222222222222222222222222222222222';
const h='0x'+'ab'.repeat(32),txHash='0x'+'cd'.repeat(32),releaseHash='0x'+'ee'.repeat(32),blockHash='0x'+'ef'.repeat(32);
const pm=getPaymentMethodsCatalog(8453,'production').revolut.paymentMethodHash;
const currency=keccak256(toHex('GBP'));
function fixture(){
 const quote={id:'quote-1',agentId:'agent',sample:false,payer,recipient,pence:1000,platform:'revolut',expiresAt:new Date(Date.now()+60000).toISOString(),offers:[{id:'0',output:'12.000000'}]};
 const raw={intent:{depositId:1,escrowAddress:ESCROW,orchestratorAddress:ORCHESTRATOR.address,chainId:'8453',toAddress:recipient,processorName:'revolut',fiatCurrencyCode:'GBP',amount:'12500000',payeeDetails:keccak256(toHex('seller'))},maker:{offchainId:'seller'},tokenAmount:'12000000',signalIntentAmount:'12500000',conversionRate:'800000000000000000',disputeProtectionRequiresStake:false};
 const execution=executionFor(raw,quote);
 const a={escrow:ESCROW,depositId:1n,amount:12500000n,to:recipient,paymentMethod:pm,fiatCurrency:currency,conversionRate:800000000000000000n,gatingServiceSignature:'0x',signatureExpiration:BigInt(Math.floor(Date.now()/1000)+60),postIntentHook:zeroAddress,data:'0x',referralFees:[],preIntentHookData:'0x'};
 const prepared={chainId:8453,to:ORCHESTRATOR.address,value:0n,data:encodeFunctionData({abi:ORCHESTRATOR.abi,functionName:'signalIntent',args:[a]})};
 const tx=validatePrepared(prepared,execution);
 return {quote,raw,execution,tx,a,order:{id:'order',kind:'native',source:'live',quote,execution,tx,expirationSeconds:3600,status:'reservation_pending',reservationTx:txHash,intentHash:h}};
}
function log(abi,eventName,args,address){const event=abi.find(x=>x.type==='event'&&x.name===eventName);return {address,topics:encodeEventTopics({abi:[event],eventName,args}),data:encodeAbiParameters(event.inputs.filter(i=>!i.indexed),event.inputs.filter(i=>!i.indexed).map(i=>args[i.name]))};}
function reservation(f){return {status:'success',transactionHash:txHash,blockNumber:100n,blockHash,logs:[log(ORCHESTRATOR.abi,'IntentSignaled',{intentHash:h,escrow:ESCROW,depositId:1n,paymentMethod:pm,owner:payer,to:recipient,amount:12500000n,fiatCurrency:currency,conversionRate:800000000000000000n,timestamp:BigInt(Math.floor(Date.now()/1000))},ORCHESTRATOR.address)]};}
function transaction(f){return {from:payer,to:ORCHESTRATOR.address,input:f.tx.data,value:0n};}
function delivery(){return {status:'success',transactionHash:releaseHash,blockNumber:120n,blockHash,logs:[log(ORCHESTRATOR.abi,'IntentFulfilled',{intentHash:h,fundsTransferredTo:recipient,amount:12000000n,isManualRelease:false},ORCHESTRATOR.address),log(erc20Abi,'Transfer',{from:ORCHESTRATOR.address,to:recipient,value:12000000n},TOKEN)]};}
test('quote execution rejects staking, tampered seller, wrong chain, rate and extra fees',()=>{
 const f=fixture();assert.equal(f.execution.net,'12000000');
 for(const edit of [r=>r.disputeProtectionRequiresStake=true,r=>r.intent.payeeDetails='not-a-hash',r=>r.intent.chainId='4217',r=>r.intent.toAddress=payer,r=>r.conversionRate='900000000000000000']){const r=structuredClone(f.raw);edit(r);assert.throws(()=>executionFor(r,f.quote));}
 const data=encodeFunctionData({abi:ORCHESTRATOR.abi,functionName:'signalIntent',args:[{...f.a,referralFees:[{recipient:payer,fee:1n}]}]});assert.throws(()=>validatePrepared({...f.tx,data},f.execution));
});
test('maker lookup is tied to the actual deposit hash and USDC token',()=>{
 const {execution}=fixture(),maker={success:true,responseObject:{processorName:'revolut',offchainId:'seller',hashedOnchainId:execution.params.payeeDetails}},deposit={deposit:{token:TOKEN},paymentMethods:[{paymentMethod:pm,verificationData:{payeeDetails:execution.params.payeeDetails}}]};
 validatePayee(execution,maker,deposit);
 assert.throws(()=>validatePayee({...execution,recipient:'other'},maker,deposit));
 assert.throws(()=>validatePayee(execution,maker,{...deposit,deposit:{token:recipient}}));
 assert.throws(()=>validatePayee(execution,maker,{...deposit,paymentMethods:[]}));
});
test('quoted Peer service fee is accepted only at its exact rate',()=>{
 const f=fixture(),raw={...f.raw,serviceFeeBps:95,tokenAmount:'12381250'};
 const execution=executionFor(raw,f.quote),fee={recipient:payer,fee:9500000000000000n};
 const data=encodeFunctionData({abi:ORCHESTRATOR.abi,functionName:'signalIntent',args:[{...f.a,referralFees:[fee]}]});
 validatePrepared({...f.tx,data},execution);
 assert.throws(()=>validatePrepared({...f.tx,data},{...execution,feeRate:'9600000000000000'}));
 assert.throws(()=>validatePrepared({...f.tx,data},{...execution,net:'12500000'}));
});
test('reservation is bound to exact sender, calldata, contract, amount and event',()=>{
 const f=fixture(),r=reservation(f),t=transaction(f);assert.equal(validateReservation(f.order,r,t).intentHash,h);
 for(const edit of [x=>x.from=recipient,x=>x.to=recipient,x=>x.input='0x',x=>x.value=1n]){const x={...t};edit(x);assert.throws(()=>validateReservation(f.order,r,x));}
 for(const edit of [x=>x.status='reverted',x=>x.logs[0].address=recipient,x=>x.logs.push(x.logs[0])]){const x=structuredClone(r);edit(x);assert.throws(()=>validateReservation(f.order,x,t));}
});
test('receipt needs the exact intent, real token, correct recipient and matching transfer',()=>{
 const f=fixture();assert.equal(validateDelivery(f.order,delivery()).amountRaw,'12000000');
 for(const edit of [r=>r.logs[1].address=recipient,r=>r.logs.pop(),r=>r.status='reverted',r=>r.logs[0].address=recipient]){const r=delivery();edit(r);assert.throws(()=>validateDelivery(f.order,r));}
 assert.throws(()=>validateDelivery({...f.order,intentHash:txHash},delivery()));
 assert.throws(()=>validateDelivery({...f.order,quote:{...f.quote,recipient:payer}},delivery()));
 assert.throws(()=>validateDelivery({...f.order,execution:{...f.execution,net:'13000000'}},delivery()));
});
test('polling waits for finality and discovers seller release without a browser callback',async()=>{
 const f=fixture();let finalized=119n;
 const rpc={getTransactionReceipt:async({hash})=>hash===txHash?reservation(f):delivery(),getTransaction:async()=>transaction(f),getBlock:async({blockTag})=>({hash:blockHash,number:blockTag==='finalized'?finalized:100n}),getBlockNumber:async()=>125n,getLogs:async()=>[{transactionHash:releaseHash}]};
 let result=await reconcile(f.order,{rpc});assert.equal(result.status,'confirming');assert.equal(result.releaseTx,releaseHash);
 finalized=120n;result=await reconcile({...f.order,...result},{rpc});assert.equal(result.status,'received');
 rpc.getBlock=async()=>({hash:txHash,number:120n});assert.equal((await reconcile(f.order,{rpc})).status,'reservation_pending');
});
test('RPC outages and absent receipts never become success; unknown releases stay blocked',async()=>{
 const f=fixture();await assert.rejects(reconcile(f.order,{rpc:{getTransactionReceipt:async()=>{throw Error('offline');}}}));
 assert.equal((await reconcile(f.order,{rpc:{getTransactionReceipt:async()=>{throw {name:'TransactionReceiptNotFoundError'};}}})).status,'reservation_pending');
 const rpc={getTransactionReceipt:async()=>reservation(f),getTransaction:async()=>transaction(f),getBlock:async()=>({hash:blockHash,number:110n}),getBlockNumber:async()=>110n,getLogs:async()=>[]};
 assert.equal((await reconcile({...f.order,releaseAttempt:true},{rpc})).status,'release_unknown');
 assert.equal((await reconcile(f.order,{rpc,now:Date.now()+7200000})).status,'expired_unresolved');
});
test('payment capture uses exact row fields and original index, never filtered UI position',()=>{
 const f=fixture(),order={...f.order,payment:{recipient:'seller'}},row={hidden:false,amount:'10.00',currency:'GBP',recipient:'seller',originalIndex:9,params:{id:'p-1'}};
 const message={platform:'revolut',expiresAt:Date.now()+60000,metadata:[row],buyerTeeCapture:{encryptedSessionMaterial:'test-only-ciphertext'}};
 assert.ok(matchingPayment(row,order));assert.equal(buildProof(message,row,order).params.index,9);
 assert.ok(!matchingPayment({...row,recipient:'other'},order));assert.ok(!matchingPayment({...row,amount:'9.99'},order));
 assert.throws(()=>buildProof({...message,expiresAt:1},row,order));assert.throws(()=>buildProof({...message,platform:'wise'},row,order));
 assert.throws(()=>buildProof(message,{...row},order));
 const wise={...order,quote:{...order.quote,platform:'wise'}};assert.ok(!('index' in buildProof({...message,platform:'wise'},row,wise).params));
 assert.ok(extensionSupported('0.6.3'));assert.ok(!extensionSupported('0.6.2'));assert.ok(!extensionSupported('bad'));
});
test('read-only RPC proxy rejects sends and malformed requests before network use',async()=>{
 for(const body of [{jsonrpc:'2.0',method:'eth_sendRawTransaction',params:[]},{jsonrpc:'2.0',method:'personal_sign',params:[]},[]])await assert.rejects(proxyRpc(body));
});
test('private seller and execution data are withheld before reservation',()=>{const f=fixture();assert.equal(publicOrder({...f.order,status:'ready_to_reserve'}).payment,undefined);assert.equal(publicOrder(f.order).execution,undefined);assert.equal(publicOrder({...f.order,status:'awaiting_payment'}).payment.recipient,'seller');});
test('fixture preview cookie cannot replace the application session cookie',async()=>{
 const server=createApp({cookieName:'relay_peer_fixture'});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/state`,{headers:{Cookie:'relay_peer_session=existing-app-cookie'}});assert.ok(r.headers.get('set-cookie').startsWith('relay_peer_fixture='));assert.ok(!r.headers.get('set-cookie').includes('relay_peer_session='));}
 finally{server.close();await once(server,'close');}
});
test('HTTP native workflow: private quote, one order, recoverable attempt, no simulation and session isolation',async()=>{
 const f=fixture();let preparedCalls=0;
 const server=createApp({offerService:async()=>({...f.quote,_execution:[f.raw]}),prepareService:async()=>{preparedCalls++;return {execution:f.execution,tx:f.tx,expirationSeconds:3600};},reconcileService:async()=>({status:'awaiting_payment',intentHash:h,expiresAt:new Date(Date.now()+60000).toISOString()})});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try{
 const r=await fetch(base+'/api/state',{headers:{Cookie:'relay_peer_session=__proto__'}});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];const post=(p,b)=>fetch(base+'/api/'+p,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,Cookie:cookie},body:JSON.stringify(b)});
 let s=await (await post('agents',{name:'Test agent',address:recipient,network:'base',own:true})).json();const agentId=s.agents[0].id;
 let q=await (await post('offers',{sample:false,agentId,recipient})).json();assert.equal(q._execution,undefined);
 const body={quoteId:q.id,offerId:'0',requestId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',confirm:true};
 s=await (await post('live-orders',body)).json();const o=s.orders[0];assert.equal(o.status,'ready_to_reserve');assert.equal(o.payment,undefined);assert.equal(o.execution,undefined);
 await post('live-orders',body);assert.equal(preparedCalls,1);
 assert.equal((await post('advance',{id:o.id,expected:o.status})).status,409);
 await post('live-attempt',{id:o.id,phase:'reserve'});assert.equal((await post('live-attempt',{id:o.id,phase:'reserve'})).status,409);
 assert.equal((await post('live-abandon',{id:o.id})).status,409);
 await post('live-submitted',{id:o.id,phase:'reserve',hash:txHash});s=await (await post('live-refresh',{id:o.id})).json();assert.equal(s.orders[0].status,'awaiting_payment');assert.equal(s.orders[0].payment.recipient,'seller');
 assert.equal((await post('live-submitted',{id:o.id,phase:'reserve',hash:releaseHash})).status,409);
 const other=await fetch(base+'/api/state');assert.equal((await other.json()).orders.length,0);
 }finally{server.close();await once(server,'close');}
});
