// Quote-only preparation. The resolver is server-owned and must verify the session,
// existing buyer-wallet link and ownership of the saved receiving-wallet record.
// No production resolver is installed by this release. Browser addresses are rejected.
import {createHash} from 'node:crypto';
import {getAddress} from 'viem';
import {BASE_USDC,QuoteError} from './direct-quote.mjs';
import {calculatorInput,calculatorPolicy} from './target-calculator.mjs';
import {createQuoteReader,getQuotesByMethod} from './quote-reader.mjs';
import {compareSelectedQuote} from './quote-review.mjs';
const requireThat=(v,code)=>{if(!v)throw new QuoteError(code);};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const identifier=v=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,100}$/.test(v);
function address(v){
 requireThat(typeof v==='string'&&/^0x[0-9a-f]{40}$/i.test(v)&&!/^0x0{40}$/.test(v),'invalid_wallet_address');
 const checksummed=getAddress(v);
 requireThat(v===v.toLowerCase()||v===v.toUpperCase().replace('0X','0x')||v===checksummed,'invalid_wallet_address');
 return checksummed.toLowerCase();
}
function keys(value,allowed){requireThat(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k)),'invalid_personalised_input');}
export function personalisedInput(input,{review=false}={}){
 keys(input,['amount','currency','method','receivingWalletId','contextId','shareAddresses',...(review?['offerId']:[])]);
 requireThat(identifier(input.receivingWalletId)&&/^[a-f0-9]{64}$/.test(input.contextId??'')&&input.shareAddresses===true,'address_review_required');
 if(review)requireThat(/^[a-f0-9]{64}$/.test(input.offerId??'')&&input.method&&input.method!=='all','invalid_selection');
 const target=calculatorInput({amount:input.amount,currency:input.currency,method:input.method});
 return {...target,receivingWalletId:input.receivingWalletId,contextId:input.contextId,offerId:input.offerId};
}
function resolvedContext(record,walletId,now){
 const {session,buyer,recipient}=record??{};
 requireThat(Number.isSafeInteger(now)&&now>0,'invalid_clock');
 requireThat(session&&identifier(session.owner)&&typeof session.binding==='string'&&session.binding.length>=16&&Number.isSafeInteger(session.expiresAt)&&session.expiresAt>now,'sign_in_required');
 requireThat(recipient&&recipient.id===walletId&&recipient.owner===session.owner&&recipient.enabled===true&&identifier(recipient.revision),'receiving_wallet_unavailable');
 requireThat(recipient.chainId===8453&&address(recipient.token)===BASE_USDC,'unsupported_receiving_asset');
 const receivingAddress=address(recipient.address);
 if(!buyer)return {status:'buyer_wallet_needed',reserved:false,canCreatePayment:false};
 requireThat(buyer.owner===session.owner&&buyer.sessionBinding===session.binding&&buyer.verification==='server_verified_wallet_link'&&identifier(buyer.reference),'buyer_wallet_not_verified');
 requireThat(buyer.chainId===8453,'unsupported_buyer_chain');
 requireThat(Number.isSafeInteger(buyer.verifiedAt)&&buyer.verifiedAt<=now&&buyer.verifiedAt>now-300000&&Number.isSafeInteger(buyer.expiresAt)&&buyer.expiresAt>now,'buyer_verification_expired');
 const buyingAddress=address(buyer.address),validUntil=Math.min(session.expiresAt,buyer.expiresAt,buyer.verifiedAt+300000);
 const contextId=hash([session.owner,session.binding,session.expiresAt,buyer.reference,buyingAddress,buyer.verifiedAt,buyer.expiresAt,recipient.id,recipient.revision,receivingAddress,8453,BASE_USDC]);
 return {status:'addresses_ready',contextId,validUntil,buyer:{address:buyingAddress,chainId:8453},recipient:{id:recipient.id,address:receivingAddress,chainId:8453,token:BASE_USDC},
  buyerEligibilityVerified:false,receivingPlatformSupportVerified:false,reserved:false,canCreatePayment:false};
}
export function createPersonalisedQuoteService({resolveContext,fetchImpl,clock=Date.now}={}){
 requireThat(typeof resolveContext==='function','personalised_resolver_missing');
 const reader=createQuoteReader({policy:calculatorPolicy,fetchImpl,clock});
 const load=async(actor,walletId)=>resolvedContext(await resolveContext(actor,walletId),walletId,clock());
 const service={
  async context(actor,input){keys(input,['receivingWalletId']);requireThat(identifier(input.receivingWalletId),'invalid_receiving_wallet');return load(actor,input.receivingWalletId);},
  async quotes(actor,input){
   const value=personalisedInput(input),before=await load(actor,value.receivingWalletId);
   requireThat(before.status==='addresses_ready','buyer_wallet_needed');
   requireThat(before.contextId===value.contextId,'address_context_changed');
   const rows=await getQuotesByMethod(reader,{amount:value.amount,currency:value.currency,amountMode:'receive',chainId:8453,token:BASE_USDC,buyer:before.buyer.address,recipient:before.recipient.address},value.methods);
   const after=await load(actor,value.receivingWalletId);
   requireThat(after.status==='addresses_ready'&&after.contextId===before.contextId,'address_context_changed');
   // Quotes cannot outlive the wallet/session evidence used for the request.
   for(const row of rows)for(const offer of row.offers??[])offer.validUntil=Math.min(offer.validUntil,after.validUntil);
   return {rows,input:{amount:value.amount,currency:value.currency,method:value.method},source:'peer_public_quote',route:'peer_direct',checkedAt:clock(),
    eligibility:'not_verified',addressBinding:'server_resolved',addressContext:after,reserved:false,canCreatePayment:false};
  },
  async review(actor,input){
   personalisedInput(input,{review:true});const {offerId,...target}=input;
   const fresh=await service.quotes(actor,target),result=compareSelectedQuote(offerId,fresh,{now:clock()});
   return {...result,eligibility:'not_verified',addressBinding:'server_resolved',addressContext:fresh.addressContext,
    readiness:{...result.readiness,buyer:'wallet_link_checked',destination:'saved_address_checked',eligibility:'not_verified',reservation:'disabled'}};
  }
 };
 return Object.freeze(service);
}
