// Server-only preparation for the existing GBP/Wise -> Base USDC contract.
// Not imported by hosted entrypoints. No order creation, signing or env fallback.
import {getMerchant,checkQuoteAvailability,CheckoutMode} from '@zkp2p/pay-sdk';
import {checkoutRequest} from './pay-contract.mjs';
import {InputError,pence} from './validation.mjs';
const API='https://api.pay.peer.xyz';
export function fundingAvailabilityRequest(intent){
 const n=intent?.quote?.pence;
 if(!Number.isSafeInteger(n)||n<200||n>100000||pence((n/100).toFixed(2))!==n)throw new InputError('A valid saved GBP amount is required.');
 if(!['Base','base'].includes(intent?.agent?.network)||intent.agent.token!=='USDC')throw new InputError('This funding route requires a saved Base USDC wallet.');
 const order=checkoutRequest(intent,'https://relay.invalid');
 return {amount:order.requestedFiatAmount,quoteMode:CheckoutMode.EXACT_FIAT,fiatCurrency:'GBP',enabledRails:order.enabledRails,destinationChainId:order.destinationChainId,destinationToken:order.destinationToken,destinationAddress:order.destinationAddress};
}
export function createGbpFundingPreflight({apiKey,merchantId,environment,authorisedProviderReads=false,fetcher=fetch}={}){
 if(authorisedProviderReads!==true||typeof apiKey!=='string'||!apiKey||!/^[-a-zA-Z0-9_]{1,128}$/.test(merchantId??'')||!['LIVE','SANDBOX'].includes(environment))throw Error('Funding checks need an explicitly authorised provider connection and pinned workspace.');
 const safeFetch=(url,options)=>fetcher(url,{...options,redirect:'error'});
 const options=()=>({apiBaseUrl:API,apiKey,fetcher:safeFetch,signal:AbortSignal.timeout(15000)});
 return Object.freeze({async check(intent){
  const request=fundingAvailabilityRequest(intent);
  let merchant;
  try{merchant=await getMerchant(options());}catch{throw new InputError('Funding availability could not be checked. No order was created.',503);}
  if(merchant.id!==merchantId||merchant.environment!==environment)throw new InputError('The provider connection does not match the configured workspace.',409);
  if(!merchant.merchantConfig?.enabledRails?.includes('wise'))throw new InputError('Wise is not enabled for this workspace.',409);
  let result;
  try{result=await checkQuoteAvailability(request,options());}catch{throw new InputError('Funding availability could not be checked. No order was created.',503);}
  if(typeof result?.available!=='boolean'||!Number.isSafeInteger(result.quoteCount)||result.quoteCount<0||result.available!==(result.quoteCount>0))throw new InputError('Funding availability was inconclusive. No order was created.',503);
  // Never turn liquidity into eligibility, extension-free verification, a locked
  // FX rate or an arrival claim. No nearby amount is automatically substituted.
  return {provider:'peer-pay',environment,currency:'GBP',amount:request.amount,rail:'wise',destination:{network:'Base',chainId:8453,token:'USDC',address:request.destinationAddress},liquidityAvailable:result.available,quoteCount:result.quoteCount,liquidityReserved:false,extensionFreeVerified:false,liveRouteApproved:false,canCreatePayment:false,checkedAt:new Date().toISOString()};
 }});
}
