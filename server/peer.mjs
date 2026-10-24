import { Zkp2pClient } from '@zkp2p/sdk';
import { createWalletClient, custom } from 'viem';
import { base } from 'viem/chains';
import {TOKEN,InputError,pence,address} from './validation.mjs';
export {TOKEN,InputError,pence,address} from './validation.mjs';
export const SAMPLE='0x0000000000000000000000000000000000000001';
export const PLATFORMS=['revolut','wise','monzo'];
// This client has no keys and cannot send or sign a transaction, even by accident.
const denyTransport=custom({request:async()=>{throw new Error('Wallet operations are disabled in this prototype.');}});
const client=new Zkp2pClient({walletClient:createWalletClient({account:SAMPLE,chain:base,transport:denyTransport}),rpcTransport:denyTransport,chainId:8453,runtimeEnv:'production',baseApiUrl:'https://api.zkp2p.xyz',timeouts:{api:15000}});
export function requestFor(input){
 const amount=pence(input.amount);
 if(!PLATFORMS.includes(input.platform))throw new InputError('Choose Revolut, Wise or Monzo.');
 if(input.network!=='base'||input.token!=='USDC')throw new InputError('Only USDC on Base is supported here. Tempo access is unverified.');
 const isSample=input.sample===true;
 if(!isSample&&input.consent!==true)throw new InputError('Confirm sharing the two wallet addresses with Peer for this quote.');
 return {paymentPlatforms:[input.platform],fiatCurrency:'GBP',user:isSample?SAMPLE:address(input.payer),recipient:isSample?SAMPLE:address(input.recipient),destinationChainId:8453,destinationToken:TOKEN,amount:String(BigInt(amount)*10000n),isExactFiat:true,mode:'eligible',quotePreference:'PREFER_BUYER_TEE',quotesToReturn:3};
}
export async function getOffers(input,{getQuote=(r)=>client.getQuote(r),now=Date.now(),includeExecution=false}={}){
 const req=requestFor(input);let result;
 try{result=await getQuote(req);}catch(e){if(e.status===404&&e.details?.responseBody?.errorCode==='no_quotes_found')return {provider:'Peer',source:'live',sample:input.sample===true,payer:req.user,recipient:req.recipient,pence:pence(input.amount),platform:input.platform,token:'USDC',network:'Base',chainId:8453,tokenAddress:TOKEN,checkedAt:new Date(now).toISOString(),expiresAt:null,offers:[],reason:'no_quotes_found'};throw new InputError(`Peer offers are unavailable${e.status?` (provider status ${e.status})`:''}. No order was created. Try again or view Peer directly.`,502);}
 const r=result?.responseObject;
 if(!result?.success||!r||!Array.isArray(r.quotes))throw new InputError('Peer did not return a valid offer list. No order was created.',502);
 if(r.token?.chainId!==8453||r.token?.token?.toLowerCase()!==TOKEN||r.token?.decimals!==6||r.fiat?.currencyName!=='GBP')throw new InputError('Peer returned a different currency, token or network. Offers withheld.',502);
 const expiry=Date.parse(r.quoteExpiresAt);if(!Number.isFinite(expiry)||expiry<=now)throw new InputError('Peer returned expired offers. Refresh to request new ones.',502);
 const eligible=r.quotes.filter(q=>q.intent?.processorName===input.platform&&q.intent?.toAddress?.toLowerCase()===req.recipient.toLowerCase()&&q.maker?.offchainId&&/^\d+$/.test(q.tokenAmount)&&BigInt(q.tokenAmount)>0n&&q.fiatAmount===req.amount);const offers=eligible.map((q,i)=>({id:String(i),platform:input.platform,output:(Number(q.tokenAmount)/1e6).toFixed(6),fee:typeof q.totalFeeAmountFormatted==='string'?q.totalFeeAmountFormatted:'Not supplied',verification:q.sellerAutomatedReleaseAvailable?'Seller verification available':'Buyer payment verification',requiresStake:q.disputeProtectionRequiresStake===true}));
 return {provider:'Peer',source:'live',sample:input.sample===true,payer:req.user,recipient:req.recipient,pence:pence(input.amount),platform:input.platform,token:'USDC',network:'Base',chainId:8453,tokenAddress:TOKEN,checkedAt:new Date(now).toISOString(),expiresAt:new Date(expiry).toISOString(),offers,...(includeExecution&&input.sample!==true?{_execution:eligible}: {})};
}
export function practiceQuote(input){requestFor({...input,sample:true});const n=pence(input.amount);const fee=Math.max(20,Math.round(n/100));return {source:'practice',pence:n,feePence:fee,output:((n-fee)*1.25/100).toFixed(6),platform:input.platform,token:'USDC',network:'Base'};}
export const STAGES=['offer_selected','payment_sent','payment_verified','delivered'];
export function advance(order,expected){if(order.source!=='practice')throw new InputError('Real payment completion cannot be simulated.',409);if(order.status!==expected)throw new InputError('This order has changed. Refresh it first.',409);const next=STAGES[STAGES.indexOf(expected)+1];if(!next)throw new InputError('This example is already complete.',409);order.status=next;order.events.push({status:next,at:new Date().toISOString()});}
