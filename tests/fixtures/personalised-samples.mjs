import samples from './public-calculator-quotes.json' with {type:'json'};
import {calculatorPolicy} from '../../server/quote-first/target-calculator.mjs';
import {BASE_USDC} from '../../server/quote-first/direct-quote.mjs';
export const sampleBuyer='0x0000000000000000000000000000000000000011';
export const sampleRecipients=Object.freeze({research:'0x0000000000000000000000000000000000000022',assistant:'0x0000000000000000000000000000000000000033'});
export function personalisationRecord(walletId='research',now=Date.now()){
 return {session:{owner:'sample_customer',binding:'sample_session_binding_2026',expiresAt:now+3600000},
  buyer:{owner:'sample_customer',sessionBinding:'sample_session_binding_2026',address:sampleBuyer,chainId:8453,verification:'server_verified_wallet_link',verifiedAt:now,expiresAt:now+300000,reference:'sample_link'},
  recipient:{id:walletId,owner:'sample_customer',address:sampleRecipients[walletId],chainId:8453,token:BASE_USDC,revision:'1',enabled:true}};
}
export function personalisedSamplePayload(body,now=Date.now(),scenario='available'){
 const method=body.paymentPlatforms[0],payload=structuredClone(samples.wise.response),r=payload.responseObject;
 const route=calculatorPolicy.routes.find(x=>x.method===method&&x.currency===body.fiatCurrency);if(!route)throw Error('Invalid sample route');
 r.fiat.currencyName=body.fiatCurrency;r.fiat.currencyCode=route.currencyHash;r.quoteExpiresAt=new Date(now+60000).toISOString();
 if(scenario==='none'){r.quotes=[];return payload;}
 for(const q of r.quotes){
  const net=BigInt(body.exactTokenAmount),gross=net*10000n/9905n,fee=gross-net;
  q.paymentMethod=method;q.intent.processorName=method;q.intent.toAddress=body.recipient;q.intent.fiatCurrencyCode=route.currencyHash;
  q.tokenAmount=String(net);q.signalIntentAmount=String(gross);q.intent.amount=String(gross);q.totalFeeAmount=String(fee);q.zkp2pFeeAmount=String(fee);q.managerFeeAmount='0';
  if(scenario==='changed'){q.conversionRate=String(BigInt(q.conversionRate)*11n/10n);q.intent.conversionRate=q.conversionRate;}
  q.fiatAmount=String((gross*BigInt(q.conversionRate)+10n**18n-1n)/10n**18n);
 }
 return payload;
}
