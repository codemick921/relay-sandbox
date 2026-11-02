// Read-only enrollment observation. A candidate is NOT a pinned quote wallet.
import {createHash} from 'node:crypto';
import {getAddress} from 'viem';
import {QuoteError} from './direct-quote.mjs';
import {quoteTestEnrollment} from './buyer-wallet-resolver.mjs';
const check=(v,code)=>{if(!v)throw new QuoteError(code);};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function setupTestEnrollment(record,clock=Date.now){
 check(record&&!Object.hasOwn(record,'buyingAddress'),'wallet_setup_configuration');
 return quoteTestEnrollment({...record,buyingAddress:null},clock);
}
export function classifySetupWallet(user,{privyDid,subject}){
 if(!user||user.id!==privyDid||!Array.isArray(user.linkedAccounts))return {status:'blocked',reason:'identity_mismatch'};
 const accounts=user.linkedAccounts;
 if(accounts.some(a=>!a||typeof a!=='object'))return {status:'blocked',reason:'invalid_inventory'};
 const identities=accounts.filter(a=>a.type==='custom_auth');
 if(identities.length!==1||identities[0].subject!==subject)return {status:'blocked',reason:'identity_mismatch'};
 if(accounts.some(a=>!['custom_auth','wallet'].includes(a.type)))return {status:'blocked',reason:'unexpected_account'};
 const wallets=accounts.filter(a=>a.type==='wallet');
 if(wallets.length===0)return {status:'none'};
 if(wallets.length!==1)return {status:'blocked',reason:'ambiguous_wallets'};
 const w=wallets[0];
 if(w.chainType!=='ethereum'||w.walletClientType!=='privy'||w.connectorType!=='embedded'||w.userCanSign!==true||w.delegated!==false||w.imported!==false)return {status:'blocked',reason:'unsupported_wallet'};
 let address;
 try{if(!/^0x[0-9a-f]{40}$/i.test(w.address??'')||/^0x0{40}$/i.test(w.address))throw Error();address=getAddress(w.address);}catch{return {status:'blocked',reason:'invalid_address'};}
 return {status:'candidate',candidate:{address,chainType:'ethereum',userCanSign:true,delegated:false,imported:false}};
}
// This is a dated operator assertion, never proof that recovery actually works.
export function recoveryEvidenceState(evidence,expectedHash,now,appId){
 if(!evidence||!/^[a-f0-9]{64}$/.test(expectedHash??''))return 'not_verified';
 const keys=['appId','sdkVersion','reviewedAt','expiresAt','evidenceReference','reentryReviewed','exportReviewed','noAdditionalSigners'];
 if(Object.keys(evidence).length!==keys.length||Object.keys(evidence).some(k=>!keys.includes(k))||hash(evidence)!==expectedHash||evidence.appId!==appId||evidence.sdkVersion!=='3.51.0'||!Number.isSafeInteger(evidence.reviewedAt)||evidence.reviewedAt>now||!Number.isSafeInteger(evidence.expiresAt)||evidence.expiresAt<=now||evidence.expiresAt-evidence.reviewedAt>86400000||typeof evidence.evidenceReference!=='string'||!/^[a-zA-Z0-9_.-]{1,100}$/.test(evidence.evidenceReference)||![evidence.reentryReviewed,evidence.exportReviewed,evidence.noAdditionalSigners].every(v=>v===true))return 'not_verified';
 return 'operator_reviewed';
}
export function createWalletSetupObserver({enabled=()=>false,resolveSession,resolveEnrollment,verifyAccessToken,readPrivyUser,clock=Date.now,recoveryState=()=> 'not_verified'}={}){
 const valid=s=>s&&typeof s.owner==='string'&&typeof s.binding==='string'&&s.binding.length>=16&&Number.isSafeInteger(s.expiresAt)&&s.expiresAt>clock();
 return async actor=>{
  check(enabled()===true,'wallet_setup_disabled');
  check(actor&&Object.keys(actor).length===2&&/^[a-f0-9]{64}$/.test(actor.sessionToken??'')&&typeof actor.accessToken==='string'&&actor.accessToken.length<=8192,'sign_in_required');
  const session=structuredClone(await resolveSession(actor.sessionToken));check(valid(session),'sign_in_required');
  const enrollment=structuredClone(await resolveEnrollment(session.owner));
  check(enrollment&&enrollment.owner===session.owner&&enrollment.environment==='development'&&enrollment.buyingAddress===null&&enrollment.consent===true&&enrollment.expiresAt>clock(),'buyer_not_enrolled');
  const access=await verifyAccessToken(actor.accessToken);check(access.did===enrollment.privyDid&&access.expiresAt>clock(),'buyer_identity_mismatch');
  const user=await readPrivyUser(access.did),result=classifySetupWallet(user,enrollment);
  const current=await resolveSession(actor.sessionToken),latest=await resolveEnrollment(session.owner);
  check(enabled()===true&&valid(current)&&hash(current)===hash(session)&&latest&&hash(latest)===hash(enrollment)&&latest.expiresAt>clock()&&access.expiresAt>clock(),'buyer_context_changed');
  const observedAt=clock(),validUntil=Math.min(observedAt+30000,session.expiresAt,enrollment.expiresAt,access.expiresAt);
  // No token/owner/subject/raw user response is returned or persisted.
  return {...result,observedAt,validUntil,contextId:hash([session.binding,hash(actor.accessToken),enrollment,result,observedAt]),
   recovery:recoveryState(),recoveryContentsMachineVerified:false,pinned:false,canQuote:false,canCreateWallet:false,canCreatePayment:false};
 };
}
