// Transport-independent sample controller. It never imports a wallet SDK.
export function createWalletSetupController({driver,onChange=()=>{},timeoutMs=2200,now=Date.now}) {
 if(driver?.mode!=='sample-only')throw Error('Sample driver required');
 let state={phase:'checking',consent:false,wallet:null,context:null},generation=0,disposed=false;
 const emit=patch=>{state={...state,...patch};if(!disposed)onChange({...state});};
 const current=n=>!disposed&&generation===n;
 async function request(op){let timer;try{return await Promise.race([driver[op](),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('unknown')),timeoutMs);})]);}finally{clearTimeout(timer);}}
 const applyRead=r=>{
  if(r.status==='expired'||r.status==='wrongIdentity')return emit({phase:r.status,wallet:null,context:null,consent:false});
  if(r.status==='found')return emit({phase:'existing',wallet:r.wallet,context:null,consent:false});
  emit({phase:r.status==='none'?'ready':'unknown',wallet:null,context:null,consent:false});
 };
 async function inspect(){if(disposed||['checking','creating','verifying'].includes(state.phase)&&generation>0)return;const n=++generation;emit({phase:'checking',consent:false,context:null,wallet:null});try{const r=await request('inspect');if(current(n))applyRead(r);}catch{if(current(n))emit({phase:'unknown'});}}
 async function verify(){if(disposed||!['created','existing','verified','verificationFailed'].includes(state.phase))return;const n=++generation;emit({phase:'verifying',context:null,consent:false});try{const r=await request('verify');if(!current(n))return;
  if(r.status==='verified'&&r.sample===true&&r.expiresAt>now()&&r.context?.status==='addresses_ready'&&r.context.buyer?.address===state.wallet?.address)emit({phase:'verified',context:r.context,expiresAt:r.expiresAt});
  else emit({phase:['expired','wrongIdentity'].includes(r.status)?r.status:'verificationFailed',context:null,wallet:null});
 }catch{if(current(n))emit({phase:'verificationFailed',context:null,wallet:null});}}
 async function create(){if(disposed||state.phase!=='ready'||!state.consent)return;const n=++generation;emit({phase:'creating',consent:false});try{const r=await request('create');if(!current(n))return;
  if(r.status==='found'){emit({phase:'created',wallet:r.wallet});await verify();}
  else emit({phase:['cancelled','failed','expired','wrongIdentity'].includes(r.status)?r.status:'unknown'});
 }catch{if(current(n))emit({phase:'unknown'});}}
 return {getState:()=>({...state}),inspect,create,verify,
  consent:value=>{if(state.phase==='ready')emit({consent:value===true});},
  cancel:()=>{if(disposed)return;const ambiguous=['creating','unknown','verifying'].includes(state.phase);generation++;emit({phase:ambiguous?'unknown':'cancelled',consent:false,wallet:null,context:null});},
  expire:()=>{if(state.phase==='verified'&&state.expiresAt<=now()){generation++;emit({phase:'expired',context:null,wallet:null,consent:false});}},
  dispose:()=>{generation++;disposed=true;}
 };
}
