import samples from './public-calculator-quotes.json' with {type:'json'};
import {calculatorPolicy,calculatorInput} from '../../server/quote-first/target-calculator.mjs';
import {normaliseQuoteResponse,buildQuoteRequest,BASE_USDC} from '../../server/quote-first/direct-quote.mjs';
import {customerQuoteView} from '../../server/quote-first/quote-reader.mjs';
export function calculatorSamples(input,scenario='available',now=Date.now()){
 const value=calculatorInput(input);
 if(!['available','none','invalid','expiry','failure'].includes(scenario))throw Error('Unknown sample');
 if(scenario==='failure')throw Error('Provider unavailable');
 const rows=value.methods.map(method=>{
  if(scenario==='none'||method==='monzo'||method==='cashapp')return {method,status:'no_quotes',offers:[]};
  const built=buildQuoteRequest({amount:input.amount,currency:input.currency,amountMode:'receive',method,chainId:8453,token:BASE_USDC,buyer:samples.wise.request.user,recipient:samples.wise.request.recipient},calculatorPolicy);
  const payload=structuredClone(samples[method].response),r=payload.responseObject;
  r.fiat.currencyName=input.currency;r.fiat.currencyCode=calculatorPolicy.routes.find(x=>x.method===method&&x.currency===input.currency).currencyHash;
  r.quoteExpiresAt=new Date(now+(scenario==='expiry'?6500:3600000)).toISOString();
  for(const q of r.quotes){
   const net=BigInt(built.context.amountRaw),gross=net*10000n/9905n,fee=gross-net;
   q.tokenAmount=String(net);q.signalIntentAmount=String(gross);q.intent.amount=String(gross);q.totalFeeAmount=String(fee);q.zkp2pFeeAmount=String(fee);q.managerFeeAmount='0';q.intent.fiatCurrencyCode=r.fiat.currencyCode;
   q.fiatAmount=String((gross*BigInt(q.conversionRate)+10n**18n-1n)/10n**18n);
   if(scenario==='invalid')q.totalFeeAmount='1';
  }
  const result=normaliseQuoteResponse(payload,built,calculatorPolicy,{now});
  return {method,...customerQuoteView({result})};
 });
 return {rows,input,checkedAt:now,source:'fabricated_sample',route:'peer_direct',reserved:false,canCreatePayment:false};
}
