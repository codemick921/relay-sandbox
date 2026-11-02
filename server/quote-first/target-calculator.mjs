// Public price comparison only: no customer addresses, credentials or signing capability.
import {keccak256,toBytes} from 'viem';
import {fundingCatalog} from '../../shared/fiat.mjs';
import {BASE_USDC,decimalUnits,QuoteError} from './direct-quote.mjs';
import {createQuoteReader,getQuotesByMethod} from './quote-reader.mjs';
export const calculatorMethods=fundingCatalog.methods.filter(m=>m.checkoutSupported).map(({id,label,currencies})=>({id,label,currencies}));
export const calculatorCurrencies=fundingCatalog.currencies.filter(c=>calculatorMethods.some(m=>m.currencies.includes(c.code)));
export const calculatorPolicy=Object.freeze({routes:calculatorMethods.flatMap(m=>m.currencies.map(currency=>({method:m.id,currency,currencyHash:keccak256(toBytes(currency))}))),escrows:['0x777777779d229cdf3110e9de47943791c26300ef'],orchestrators:['0x74c55679268fafb493864915ad16a320ab8c40ba'],maxAgeMs:60000});
export function calculatorInput(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['amount','currency','method'].includes(k)))throw new QuoteError('invalid_calculator_input');
 const raw=BigInt(decimalUnits(input.amount));
 if(raw<10000n||raw>10000000000n)throw new QuoteError('target_out_of_range');
 const methods=calculatorMethods.filter(m=>m.currencies.includes(input.currency)&&(!input.method||input.method==='all'||m.id===input.method));
 if(!methods.length)throw new QuoteError('unsupported_route');
 return {amount:input.amount,currency:input.currency,method:input.method||'all',methods:methods.map(m=>m.id)};
}
export function createTargetCalculator({fetchImpl,clock=Date.now}={}){
 const reader=createQuoteReader({policy:calculatorPolicy,fetchImpl,clock});
 return Object.freeze({async quotes(input){
  const value=calculatorInput(input);
  const rows=await getQuotesByMethod(reader,{amount:value.amount,currency:value.currency,amountMode:'receive',chainId:8453,token:BASE_USDC,buyer:'0x0000000000000000000000000000000000000001',recipient:'0x0000000000000000000000000000000000000002'},value.methods);
  return {rows,input:{amount:value.amount,currency:value.currency,method:value.method},source:'peer_public_quote',route:'peer_direct',checkedAt:clock(),eligibility:'example_addresses',reserved:false,canCreatePayment:false};
 }});
}
