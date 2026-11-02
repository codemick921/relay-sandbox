import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createWalletBootstrapHttp,configuredWalletBootstrapHttp,walletFlowPaths as paths,bootstrapPaths} from '../server/quote-first/wallet-bootstrap-http.mjs';
import {walletFlowCapabilities} from '../server/quote-first/wallet-flow-http.mjs';
import {validWalletFlowStatus,createWalletFlowRequests} from '../src/wallet-flow-client.mjs';
import {matchesWalletAuthIdentity,validWalletAuthProof} from '../src/wallet-bootstrap-client.mjs';
import {createRestrictedSetupDatabase} from '../server/quote-first/wallet-setup-database.mjs';
const now=1793629800000,owner='customer:11111111-1111-4111-8111-111111111111',subject='22222222-2222-4222-8222-222222222222',privyDid='did:privy:sample',address='0x1111111111111111111111111111111111111111',cookie='a'.repeat(64);
const session={owner,binding:'s'.repeat(64),expiresAt:now+600000},enrollment={owner,subject,privyDid,buyingAddress:null,consent:true,consentRecordedAt:now-1000,expiresAt:now+300000,environment:'development'};
const wallet={type:'wallet',address,chainType:'ethereum',walletClientType:'privy',connectorType:'embedded',userCanSign:true,imported:false,delegated:false};
const user={id:privyDid,linkedAccounts:[{type:'custom_auth',subject},wallet]};
const base={origin:'https://example.test',flow:true,enabled:()=>true,resolveSession:async()=>session,resolveEnrollment:async()=>enrollment,issue:async()=>({token:'sample',expiresAt:now+60000,walletCreated:false}),verifyAccessToken:async()=>({did:privyDid,expiresAt:now+60000}),readPrivyUser:async()=>user,document:async()=>'<html>flow</html>',clock:()=>now};
async function request(h,{url=paths.status,method='GET',body='',extra={}}={}){const req=Readable.from([body]);Object.assign(req,{url,method,headers:{host:'example.test','x-forwarded-proto':'https','sec-fetch-site':'same-origin',cookie:'__Host-relay_sandbox='+cookie,origin:'https://example.test','content-type':'application/json','x-eupova-wallet-auth':'1',...extra}});const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(text){this.text=text;try{this.body=JSON.parse(text);}catch{}}};res.handled=await h(req,res);return res;}
const verify=(h,context,url=paths.verify)=>request(h,{url,method:'POST',body:JSON.stringify({intent:'wallet_auth',consent:true,context}),extra:{authorization:'Bearer sample.access.token'}});
const clientUser={id:privyDid,linkedAccounts:[{type:'custom_auth',customUserId:subject},wallet]};
test('flow defaults off before secret or database access; old auth activation cannot enable it',async()=>{
 const env=new Proxy({EUPOVA_WALLET_AUTH_DEV_ENABLED:'true',EUPOVA_BUYER_AUTH_DEV_ENABLED:'true',EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED:'true'},{get(o,k){if(k.endsWith('ENABLED'))return o[k];assert.fail('secret read');}});
 const h=configuredWalletBootstrapHttp({env,flow:true});for(const url of Object.values(paths))assert.equal((await request(h,{url})).status,404);
});
test('new flow observes an unpinned candidate without quote or creation authority; legacy auth rejects it',async()=>{
 const h=createWalletBootstrapHttp(base),s=(await request(h)).body,r=await verify(h,s.context);assert.equal(validWalletFlowStatus(s,now),true);assert.equal(r.body.status,'wallet_candidate');assert.equal(validWalletAuthProof(r.body,s,now),true);assert.equal(r.body.canQuote,false);assert.equal(r.body.canCreateWallet,false);assert.equal(matchesWalletAuthIdentity(clientUser,s),true);
 const old=createWalletBootstrapHttp({...base,flow:false}),before=(await request(old,{url:bootstrapPaths.status})).body;assert.notEqual(before.context,s.context);assert.equal((await verify(old,before.context,bootstrapPaths.verify)).status,409);assert.equal(matchesWalletAuthIdentity(clientUser,before),false);assert.equal(validWalletAuthProof(r.body,before,now),false);
});
test('flow rejects delegated, unexpected and multiple wallets; it never auto-pins a candidate',async()=>{
 for(const accounts of [[{...wallet,delegated:true}],[wallet,wallet],[wallet,{type:'email'}],[{...wallet,userCanSign:false}],[{...wallet,imported:true}]]){
  const h=createWalletBootstrapHttp({...base,readPrivyUser:async()=>({...user,linkedAccounts:[user.linkedAccounts[0],...accounts]})}),s=(await request(h)).body;assert.equal((await verify(h,s.context)).status,409);
 }
});
test('recipient list is exact-owner, guarded and read-only; session changes discard it',async()=>{
 let current=session,calls=0;const h=createWalletBootstrapHttp({...base,capabilities:()=>({creation:false,quotes:true,leaseId:null}),resolveSession:async()=>current,readRecipients:async o=>{assert.equal(o,owner);calls++;return [{id:'sample',name:'Example'}];}});
 assert.deepEqual((await request(h,{url:paths.recipients})).body.wallets,[{id:'sample',name:'Example'}]);assert.equal(calls,1);
 const disabled=createWalletBootstrapHttp({...base,readRecipients:()=>assert.fail('read')});assert.equal((await request(disabled,{url:paths.recipients})).status,404);
 const changed=createWalletBootstrapHttp({...base,capabilities:()=>({quotes:true}),resolveSession:async()=>current,readRecipients:async()=>{current={...session,binding:'changed'.repeat(8)};return [{id:'secret'}];}});const r=await request(changed,{url:paths.recipients});assert.equal(r.status,503);assert.ok(!r.text.includes('secret'));
});
test('creation capability requires exact identity, time window, flags, reviewed claim storage and lease',()=>{
 const {environment,buyingAddress,...record}=enrollment,env={EUPOVA_WALLET_SETUP_TEST_ENROLLMENT:JSON.stringify(record),EUPOVA_WALLET_SETUP_OBSERVE_ENABLED:'true',EUPOVA_WALLET_SETUP_CLAIMS_ENABLED:'true',EUPOVA_WALLET_FLOW_SETUP_LEASE_ID:'33333333-3333-4333-8333-333333333333'};
 assert.equal(walletFlowCapabilities(env,enrollment,{clock:()=>now,claimsAvailable:true}).creation,true);
 assert.equal(walletFlowCapabilities(env,enrollment,{clock:()=>now}).creation,false);
 for(const patch of [{owner:'customer:99999999-9999-4999-8999-999999999999'},{subject:'99999999-9999-4999-8999-999999999999'},{expiresAt:now+200000},{consent:false}])assert.equal(walletFlowCapabilities({...env,EUPOVA_WALLET_SETUP_TEST_ENROLLMENT:JSON.stringify({...record,...patch})},enrollment,{clock:()=>now,claimsAvailable:true}).creation,false);
 assert.equal(walletFlowCapabilities(env,{...enrollment,buyingAddress:address},{clock:()=>now,claimsAvailable:true}).creation,false);
});
test('quote capability requires separately pinned same identity and address; no automatic reuse of creation enrolment',()=>{
 const {environment,...record}=enrollment,env={EUPOVA_PERSONALISED_QUOTE_DEV_ENABLED:'true',EUPOVA_PERSONALISED_QUOTE_TEST_ENROLLMENT:JSON.stringify({...record,buyingAddress:address})};
 assert.equal(walletFlowCapabilities(env,enrollment,{clock:()=>now}).quotes,false);
 assert.equal(walletFlowCapabilities(env,{...enrollment,buyingAddress:address},{clock:()=>now}).quotes,true);
 assert.equal(walletFlowCapabilities({...env,EUPOVA_PERSONALISED_QUOTE_DEV_ENABLED:'false'},{...enrollment,buyingAddress:address},{clock:()=>now}).quotes,false);
});
test('flow requests allow only scoped quote/setup paths; revoked access discards response and expired lease makes no calls',async()=>{
 const initial=(await request(createWalletBootstrapHttp({...base,resolveEnrollment:async()=>({...enrollment,buyingAddress:address}),capabilities:()=>({quotes:true,creation:false,leaseId:null})}))).body;
 let active=true,calls=0;const sdk={authenticated:true,user:clientUser,getAccessToken:async()=> 'sample.access.token'},sessionApi={get active(){return active;},refresh:async()=>{}};
 const invoke=createWalletFlowRequests({initial,session:sessionApi,getSdk:()=>sdk,clock:()=>now,fetchImpl:async(path,o)=>{calls++;assert.equal(path,'/api/funding-calculator/personalised/context');assert.equal(o.headers.Authorization,'Bearer sample.access.token');active=false;return Response.json({privateResult:true});}});
 await assert.rejects(invoke('payments'));await assert.rejects(invoke('claim'));assert.equal(calls,0);await assert.rejects(invoke('context',{receivingWalletId:'sample'}),/connection_changed/);assert.equal(calls,1);
 const expired=createWalletFlowRequests({initial,session:sessionApi,getSdk:()=>sdk,clock:()=>now+300000,fetchImpl:()=>assert.fail('network')});await assert.rejects(expired('quotes'));
});
test('dedicated setup DB waits for commit; unknown commit result never returns permit and connection is discarded',async()=>{
 let rejectCommit=false;const commands=[],released=[];class Pool{query(){}on(){}async connect(){return{query:async sql=>{commands.push(sql);if(sql==='COMMIT'&&rejectCommit)throw Error('ack lost');},release:flag=>released.push(flag)};}end(){}}
 const db=createRestrictedSetupDatabase('postgres://sample',{Pool});assert.equal(await db.tx(async()=> 'permit'),'permit');assert.deepEqual(commands,['BEGIN','COMMIT']);rejectCommit=true;await assert.rejects(db.tx(async()=> 'never return'),/ack lost/);assert.deepEqual(released,[false,true]);assert.equal(commands.at(-1),'ROLLBACK');
});
