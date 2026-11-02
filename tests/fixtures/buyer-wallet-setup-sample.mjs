// Sample data only. No Privy API, credentials, database, signing or payments.
import {personalisationRecord,personalisedSamplePayload,sampleBuyer} from './personalised-samples.mjs';
import {createPersonalisedQuoteService} from '../../server/quote-first/personalised-quote.mjs';
export const setupScenarios=Object.freeze(['success','existing','cancelled','failure','timeout','expired','wrongIdentity','verifyFailed','slow']);
export function createSetupSample({scenario='success',delay=650,now=Date.now}={}){
 if(!setupScenarios.includes(scenario))throw Error('Invalid scenario');
 let wallet=scenario==='existing'?{address:sampleBuyer}:null,pending=false,attempts=0,uncertain=false,record=null,verificationDeadline=0;
 const started=now(),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const access=()=>scenario==='expired'||now()>=started+300000?'expired':scenario==='wrongIdentity'?'wrongIdentity':null;
 const inspect=async()=>{const blocked=access();return blocked?{status:blocked}:wallet?{status:'found',wallet}:pending||uncertain?{status:'unknown'}:{status:'none'};};
 async function create(){
  const before=await inspect();if(before.status!=='none')return before;
  // Assign synchronously after the read; re-check because another tab may have won.
  if(wallet)return{status:'found',wallet};if(pending||uncertain)return{status:'unknown'};
  pending=true;attempts++;
  await pause(scenario==='slow'?delay*6:delay);
  const blocked=access();if(blocked){pending=false;return{status:blocked};}
  if(scenario==='cancelled'||scenario==='failure'){pending=false;return{status:scenario==='cancelled'?'cancelled':'failed'};}
  wallet={address:sampleBuyer};pending=false;
  if(scenario==='timeout'){uncertain=true;return{status:'unknown'};}
  return {status:'found',wallet};
 }
 async function verify(){
  await pause(delay/3);const blocked=access();if(blocked)return{status:blocked};
  if(!wallet||pending||scenario==='verifyFailed')return{status:'verificationFailed'};
  record=personalisationRecord('research',now());record.session.expiresAt=started+300000;record.buyer.expiresAt=started+300000;
  verificationDeadline=Math.min(now()+60000,started+300000);
  const service=createPersonalisedQuoteService({resolveContext:async()=>structuredClone(record),clock:now,fetchImpl:async()=>{throw Error('Quote not requested');}});
  return {status:'verified',sample:true,expiresAt:verificationDeadline,context:await service.context('sample-session',{receivingWalletId:'research'})};
 }
 async function quote(op,input){
  if(!record||now()>=verificationDeadline||access()||!wallet||scenario==='verifyFailed')throw Error('sample_context_changed');
  const service=createPersonalisedQuoteService({resolveContext:async()=>access()?null:structuredClone(record),clock:now,fetchImpl:async(url,options)=>{
   if(url!=='https://api.zkp2p.xyz/v3/quote/exact-token?quotesToReturn=3')throw Error('Forbidden operation');
   return new Response(JSON.stringify(personalisedSamplePayload(JSON.parse(options.body),now())),{headers:{'Content-Type':'application/json'}});
  }});
  return service[op]('sample-session',input);
 }
 return {inspect,create,verify,quote,stats:()=>({attempts,pending,hasWallet:!!wallet})};
}
