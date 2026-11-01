import {paymentEmailMessage} from './payment-email-message.mjs';
// Fixed, fabricated examples. No API, account data, storage, sender or payment access.
export const emailSamples={
 arrival:{requestId:'00000001-1111-4111-8111-111111111111',kind:'arrival',code:'received',amountUsdc:'11.881250',walletName:'Research assistant',title:'Funds arrived in the agent wallet'},
 attention:{requestId:'00000005-1111-4111-8111-111111111111',kind:'attention',code:'review',amountUsdc:null,walletName:'Sample wallet',title:'Payment details need review'}
};
export function createPaymentEmailSamples(){
 let choices={arrival:false,attention:false};const seen=new Set();
 return {
  save(input){if(!input||Object.keys(input).length!==2||['arrival','attention'].some(k=>typeof input[k]!=='boolean'))throw Error('Choose both sample email options.');choices={...input};return {...choices};},
  preview(kind){
   if(!Object.hasOwn(emailSamples,kind))throw Error('Choose a sample email type.');
   if(seen.has(kind))return {message:null,reason:'This sample event has already been checked. No second email was prepared. Reload to start with fresh sample events.'};
   seen.add(kind);
   if(!choices[kind])return {message:null,reason:'This email type is off. No sample email was prepared. To try a fresh event, reload this preview, switch this type on and save.'};
   const event=emailSamples[kind];return {message:{...paymentEmailMessage(event,{sample:true}),requestId:event.requestId,walletName:event.walletName,paymentTitle:event.title}};
  }
 };
}
