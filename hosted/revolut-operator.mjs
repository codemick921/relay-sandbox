// Operator-only composition. Never import this from an HTTP server or worker.
import {getMerchant,checkQuoteAvailability} from '@zkp2p/pay-sdk';
import {createLiveCheckoutWriter} from '../server/pay-live-create.mjs';
import {fundingIntent} from './funding-drafts.mjs';
import {createLiveFunding} from './live-funding.mjs';
import {revolutFingerprint} from './revolut-test.mjs';
import {InputError} from '../server/validation.mjs';
export function createRevolutOperator({base,drafts,policy,tracker,merchantId,apiKey,origin,fetcher=fetch}){
 const authorise=async intent=>policy.permit(await drafts.review(intent.owner??(await base.query('SELECT owner FROM relay_funding_drafts WHERE id=$1',[intent.id])).rows[0]?.owner,intent.id),merchantId);
 const options=()=>({apiBaseUrl:'https://api.pay.peer.xyz',apiKey,fetcher:(url,opts)=>fetcher(url,{...opts,redirect:'error'}),signal:AbortSignal.timeout(15000)});
 const writer=createLiveCheckoutWriter({apiKey,merchantId,authorise,rail:'revolut',fetcher});
 const flow=createLiveFunding({drafts:{...drafts,claim:(owner,id,merchant)=>drafts.claim(owner,id,merchant,{guard:(c,row)=>policy.reserve(c,row,merchant)})},tracker,writer,merchantId,origin,authorise});
 return Object.freeze({
  async provision(owner,id,{walletAddress,maxTotalPence=1000,approvalRef,consentRef,hours=2}){
   const row=await drafts.review(owner,id);
   if(row.status!=='draft'||row.rail!=='revolut'||row.agent.network!=='Base'||row.agent.token!=='USDC'||row.agent.address.toLowerCase()!==walletAddress?.toLowerCase()||row.pence>maxTotalPence||!Number.isInteger(maxTotalPence)||maxTotalPence>1000||maxTotalPence<200||!Number.isInteger(hours)||hours<1||hours>24)throw new InputError('Review the exact Revolut test draft and receiving wallet.');
   await base.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431932)');
    if((await c.query('SELECT 1 FROM relay_restricted_attempt UNION ALL SELECT 1 FROM relay_revolut_attempt')).rows.length)throw new InputError('A controlled test has already been attempted.',409);
    await c.query("INSERT INTO relay_revolut_policy(owner,draft_id,draft_hash,merchant_id,wallet_address,max_total_pence,expires_at,approval_ref,consent_ref) VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 hour',$8,$9)",[owner,id,revolutFingerprint(row),merchantId,row.agent.address.toLowerCase(),maxTotalPence,hours,approvalRef,consentRef]);
   });return policy.status(owner);
  },
  async start(owner,id){
   const row=await drafts.review(owner,id);if(!await policy.permit(row,merchantId))throw new InputError('This test is not approved.',403);
   if(row.status!=='draft')return {id,attempted:false,status:row.status};
   const m=await getMerchant(options()),cfg=m.merchantConfig;
   if(m.id!==merchantId||m.environment!=='LIVE'||cfg?.feePayer!=='MERCHANT'||cfg?.buyerFeeShareBps!==0||cfg?.quotePreference!=='PREFER_SAR')throw new InputError('Live Revolut merchant settings could not be verified.',409);
   const q=await checkQuoteAvailability({amount:(row.pence/100).toFixed(2),quoteMode:'exact-fiat',fiatCurrency:'GBP',enabledRails:['revolut'],destinationChainId:8453,destinationToken:'USDC',destinationAddress:row.agent.address},options());
   if(q.available!==true||!Number.isInteger(q.quoteCount)||q.quoteCount<1)throw new InputError('No Revolut offer is available at the saved amount. No checkout was attempted.',409);
   return flow.start(owner,{id,confirm:true,consent:true});
  },
  reconcile:flow.reconcile
 });
}
