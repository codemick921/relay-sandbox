import {paymentEmailMessage} from './payment-email-message.mjs';
// Fixed, fabricated examples. No API, account data, storage, sender or payment access.
export const emailSamples={
 arrival:{requestId:'00000001-1111-4111-8111-111111111111',kind:'arrival',code:'received',amountUsdc:'11.881250',walletName:'Research assistant',title:'Funds arrived in the agent wallet'},
 attention:{requestId:'00000005-1111-4111-8111-111111111111',kind:'attention',code:'review',amountUsdc:null,walletName:'Sample wallet',title:'Payment details need review'}
};
export const attentionSampleOptions=[
 {code:'review',label:'Payment details need review'},
 {code:'partial',label:'Part payment recorded'},
 {code:'disputed',label:'Dispute recorded'},
 {code:'uncertain',label:'Checkout status uncertain'}
];
export function createPaymentEmailSamples(){
 let choices={arrival:false,attention:false};const prepared=new Map();
 return {
  save(input){if(!input||Object.keys(input).length!==2||['arrival','attention'].some(k=>typeof input[k]!=='boolean'))throw Error('Choose both sample email options.');choices={...input};return {...choices};},
  preview(kind,attentionCode='review'){
   if(!Object.hasOwn(emailSamples,kind))throw Error('Choose a sample email type.');
   const option=attentionSampleOptions.find(o=>o.code===attentionCode);
   if(kind==='attention'&&!option)throw Error('Choose a sample attention case.');
   const key=kind==='attention'?`${kind}:${attentionCode}`:kind;
   if(prepared.has(key))return {message:prepared.get(key)};
   const event=kind==='attention'?{...emailSamples.attention,code:attentionCode,title:option.label,requestId:`0000000${5+attentionSampleOptions.indexOf(option)}-1111-4111-8111-111111111111`}:emailSamples.arrival,message={...paymentEmailMessage(event,{sample:true}),requestId:event.requestId,walletName:event.walletName,paymentTitle:event.title};
   prepared.set(key,message);return {message};
  }
 };
}
