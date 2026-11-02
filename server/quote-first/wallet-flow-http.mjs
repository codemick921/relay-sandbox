import {configuredWalletBootstrapHttp} from './wallet-bootstrap-http.mjs';
import {quoteTestEnrollment} from './buyer-wallet-resolver.mjs';
import {setupTestEnrollment} from './wallet-setup-observer.mjs';
const sameIdentity=(a,b)=>a&&b&&['owner','subject','privyDid','consentRecordedAt','expiresAt'].every(k=>a[k]===b[k]);
export function walletFlowCapabilities(env,enrollment,{claimsAvailable=false,clock=Date.now}={}){
 let creation=false,quotes=false,leaseId=null;
 try{const record=JSON.parse(env.EUPOVA_WALLET_SETUP_TEST_ENROLLMENT??'');setupTestEnrollment(record,clock);
  if(sameIdentity(record,enrollment)&&enrollment.buyingAddress===null&&claimsAvailable&&env.EUPOVA_WALLET_SETUP_OBSERVE_ENABLED==='true'&&env.EUPOVA_WALLET_SETUP_CLAIMS_ENABLED==='true'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(env.EUPOVA_WALLET_FLOW_SETUP_LEASE_ID??'')){creation=true;leaseId=env.EUPOVA_WALLET_FLOW_SETUP_LEASE_ID;}
 }catch{}
 try{const record=JSON.parse(env.EUPOVA_PERSONALISED_QUOTE_TEST_ENROLLMENT??'');quoteTestEnrollment(record,clock);
  quotes=!!(sameIdentity(record,enrollment)&&enrollment.buyingAddress&&record.buyingAddress?.toLowerCase()===enrollment.buyingAddress&&env.EUPOVA_PERSONALISED_QUOTE_DEV_ENABLED==='true');
 }catch{}
 return {creation,quotes,leaseId};
}
export function configuredWalletFlowHttp(options={}){
 const {env=process.env,clock=Date.now,claimsAvailable=()=>false}=options;
 return configuredWalletBootstrapHttp({...options,flow:true,capabilities:e=>walletFlowCapabilities(env,e,{clock,claimsAvailable:claimsAvailable()})});
}
