import {Zkp2pClient,createPeerExtensionSdk} from '@zkp2p/sdk';
import {createWalletClient,custom,http,decodeFunctionData} from 'viem';
import {base} from 'viem/chains';
import {extensionSupported,ROUTES} from '../shared/payment.mjs';
import {getOrchestratorV3Contract} from '@zkp2p/sdk';
let connected;
let extension;
const peer=()=>extension??=createPeerExtensionSdk({window});
export async function checkReadiness(){return {walletAvailable:!!window.ethereum?.request,peer:await extensionState()};}
export async function connectWallet() {
  if(!window.ethereum?.request)throw Error('Open Eupova in a browser with an Ethereum wallet extension. The agent wallet can remain a separate receiving address.');
  const wallet=createWalletClient({chain:base,transport:custom(window.ethereum)});
  const [account]=await wallet.requestAddresses();
  if(!account)throw Error('No buying wallet was selected.');
  if(await wallet.getChainId()!==8453)await wallet.switchChain({id:8453});
  connected={wallet,account};return account;
}
export async function walletFor(expected) {
  if(!connected)await connectWallet();
  const {wallet}=connected,[account]=await wallet.getAddresses();
  if(account?.toLowerCase()!==expected.toLowerCase())throw Error('Connect the same buying wallet used for this offer.');
  if(await wallet.getChainId()!==8453)throw Error('Switch your buying wallet to Base before continuing.');
  return {wallet,account};
}
export async function extensionState() {
  const state=await peer().getState();
  if(state!=='ready')return {state};
  const version=await peer().getVersion();
  return {state:extensionSupported(version)?'ready':'needs_update',version};
}
export async function connectExtension() {
  let info=await extensionState();
  if(['needs_install','needs_update'].includes(info.state)){peer().openInstallPage();return info;}
  if(info.state==='needs_connection'){
    if(!await peer().requestConnection())throw Error('Peer extension access was not approved.');
    info=await extensionState();
  }
  return info;
}
export async function reserve(order) {
  const {wallet,account}=await walletFor(order.quote.payer);
  if((await extensionState()).state!=='ready')throw Error('Connect Peer extension 0.6.3 or newer before reserving an offer.');
  if(Date.parse(order.tx.expiresAt)<=Date.now()||Date.parse(order.quote.expiresAt)<=Date.now())throw Error('This offer expired. Discard this unsubmitted order and request a new quote.');
  return wallet.sendTransaction({account,chain:base,to:order.tx.to,data:order.tx.data,value:0n});
}
export async function capture(order,onMessage,onError) {
  const info=await extensionState();
  if(info.state!=='ready')throw Error('Connect Peer extension 0.6.3 or newer first.');
  const route=ROUTES[order.quote.platform];
  if(!route)throw Error('This payment app is not supported.');
  const unsubscribe=peer().onMetadataMessage(message=>{
    if(message.platform!==route.platform)return;
    if(message.errorMessage){onError('Peer could not capture the payment. Return to your payment app and try verification again.');return;}
    if(!Array.isArray(message.metadata)||message.metadata.length>200||message.metadata.some(row=>!row||typeof row!=='object')){onError('Peer returned an unsupported payment list. Restart verification.');return;}
    onMessage(message);
  });
  try{peer().authenticate({platform:route.platform,actionType:route.actionType,attestationActionType:route.actionType,captureMode:'buyerTee',attestationServiceUrl:'https://attestation-service.zkp2p.xyz'});}catch(e){unsubscribe();throw e;}
  return unsubscribe;
}
export async function prepareRelease(order,proof) {
  const {wallet,account}=await walletFor(order.quote.payer);
  const client=new Zkp2pClient({walletClient:createWalletClient({account,chain:base,transport:custom(window.ethereum)}),rpcTransport:http(new URL('/api/rpc',location.origin).href,{retryCount:0}),chainId:8453,runtimeEnv:'production',baseApiUrl:'https://api.zkp2p.xyz',timeouts:{api:30000}});
  let tx;
  try{tx=await client.fulfillIntent.prepare({intentHash:order.intentHash,orchestratorAddress:getOrchestratorV3Contract(8453,'production').address,proof,attestationServiceUrl:'https://attestation-service.zkp2p.xyz',attestationServiceFallbackUrls:[]});}
  catch{throw Error('Peer could not verify and prepare this payment. Check the selected row and reservation, then capture again. No release was submitted by this step.');}
  const contract=getOrchestratorV3Contract(8453,'production');
  if(tx.chainId!==8453||tx.to.toLowerCase()!==contract.address.toLowerCase()||BigInt(tx.value??0)!==0n)throw Error('Peer returned an unexpected release transaction.');
  const decoded=decodeFunctionData({abi:contract.abi,data:tx.data});
  if(decoded.functionName!=='fulfillIntent'||decoded.args?.[0]?.intentHash?.toLowerCase()!==order.intentHash.toLowerCase()||decoded.args[0].postIntentHookData!=='0x')throw Error('Peer returned an unexpected operation or intent.');
  return {tx,account,wallet};
}
export async function release(order,prepared) {
  const {wallet,account}=await walletFor(order.quote.payer);
  return wallet.sendTransaction({account,chain:base,to:prepared.tx.to,data:prepared.tx.data,value:0n});
}
export function wasRejected(error) {
  for(let e=error;e;e=e.cause)if(e.code===4001||e.name==='UserRejectedRequestError')return true;
  return false;
}
