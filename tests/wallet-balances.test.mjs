import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {fixture} from './fixtures/account-store.mjs';
import {createWalletBalances,parseUsdc} from '../hosted/wallet-balances.mjs';
import {formatUsdc,totalWalletBalance,walletShortfall,repeatFunding,visibleWallet} from '../src/wallet-values.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {TOKEN} from '../server/validation.mjs';
const owner=()=>`customer:${randomUUID()}`;
const agent=()=>({id:randomUUID(),name:'Example agent',address:'0x1111111111111111111111111111111111111111',network:'Base',token:'USDC'});
const rpc=(overrides={})=>({getChainId:async()=>8453,getBlock:async()=>({number:100n,timestamp:BigInt(Math.floor(Date.now()/1000))}),readContract:async()=>7250001n,...overrides});
const due=base=>base.query("UPDATE relay_wallet_balances SET next_check_at=now()-interval '1 second'");

test('USDC precision, target shortfall and complete totals never use floating-point money',()=>{
 assert.equal(parseUsdc('7.250001'),'7250001');assert.equal(parseUsdc('0.000001'),'1');
 for(const s of ['-1','1e3','1.0000001','Infinity','1000001','',5])assert.throws(()=>parseUsdc(s));
 assert.equal(formatUsdc('9007199254740993000001'),'9,007,199,254,740,993.000001');
 const w={status:'fresh',amountRaw:'7250001',targetRaw:'50000000'};
 assert.equal(walletShortfall(w),'42749999');assert.equal(totalWalletBalance([w,w]),'14500002');
 assert.equal(totalWalletBalance([w,{...w,status:'stale'}]),null);assert.equal(totalWalletBalance([]),null);
 assert.equal(walletShortfall({...w,status:'unavailable'}),null);assert.equal(walletShortfall({...w,targetRaw:'1'}),'0');
});
test('balance snapshots are scoped, persist across restart, use the pinned token/block and preserve alert preferences',async()=>{
 const f=await fixture();try{
  const a=owner(),b=owner(),w=agent();await f.store.addAgent(a,w);let contract;
  const service=createWalletBalances(f.store,{rpc:rpc({readContract:async args=>{contract=args;return 7250001n;}})});
  await service.migrate();assert.equal((await service.state(a)).wallets[0].amountRaw,null);assert.deepEqual((await service.state(b)).wallets,[]);
  await assert.rejects(service.preferences(b,{agentId:w.id,enabled:true,threshold:'10',target:'50'}),e=>e.status===404);
  await assert.rejects(service.refresh(b,{agentId:w.id}),e=>e.status===404);
  await service.preferences(a,{agentId:w.id,enabled:true,threshold:'10',target:'50'});await service.tick();
  const seen=(await service.state(a)).wallets[0];assert.equal(seen.amountRaw,'7250001');assert.equal(seen.lowBalance,true);
  assert.equal(contract.address,TOKEN);assert.equal(contract.blockNumber,100n);assert.equal(contract.functionName,'balanceOf');assert.deepEqual(contract.args,[w.address]);
  const restart=createWalletBalances(f.store,{rpc:rpc()});await restart.migrate();assert.equal((await restart.state(a)).wallets[0].targetRaw,'50000000');
  await assert.rejects(service.preferences(a,{agentId:w.id,enabled:true,threshold:'10',target:'9'}),/at least/);
  await assert.rejects(service.preferences(a,{agentId:w.id,enabled:true,threshold:'10',target:'50',owner:b}),/settings/);
  await assert.rejects(service.state('tester'),e=>e.status===403);
 }finally{await f.close();}
});
test('failed, stale and wrong-chain reads retain prior evidence, suppress alerts, and recover from zero correctly',async()=>{
 const f=await fixture();try{
  const a=owner(),w=agent();await f.store.addAgent(a,w);let broken=false,amount=0n,chain=8453,block=100n;
  const service=createWalletBalances(f.store,{rpc:rpc({getChainId:async()=>chain,getBlock:async()=>({number:block,timestamp:BigInt(Math.floor(Date.now()/1000))}),readContract:async()=>{if(broken)throw Error('private RPC detail');return amount;}})});await service.migrate();await service.state(a);
  await service.preferences(a,{agentId:w.id,enabled:true,threshold:'10',target:'50'});await service.tick();
  let s=(await service.state(a)).wallets[0];assert.equal(s.amountRaw,'0');assert.equal(s.status,'fresh');assert.equal(s.lowBalance,true);
  broken=true;await due(f.store);await service.tick();s=(await service.state(a)).wallets[0];assert.equal(s.amountRaw,'0');assert.equal(s.status,'stale');assert.equal(s.lowBalance,null);assert.ok(!JSON.stringify(s).includes('private RPC'));
  broken=false;chain=1;amount=50000000n;await due(f.store);await service.tick();assert.equal((await service.state(a)).wallets[0].amountRaw,'0');
  chain=8453;await due(f.store);await service.tick();s=(await service.state(a)).wallets[0];assert.equal(s.status,'fresh');assert.equal(s.lowBalance,false);
  block=99n;amount=1n;await due(f.store);await service.tick();s=(await service.state(a)).wallets[0];assert.equal(s.amountRaw,'50000000');assert.equal(s.status,'stale');
  await f.store.query("UPDATE relay_wallet_balances SET failed=false,observed_at=now()-interval '4 minutes'");assert.equal((await service.state(a)).wallets[0].lowBalance,null);
 }finally{await f.close();}
});
test('unavailable balance stays unknown; stale block and unsupported wallet never produce a fresh observation',async()=>{
 const f=await fixture();try{
  const a=owner(),w=agent();await f.store.addAgent(a,w);await f.store.addAgent(a,{...agent(),network:'Other',address:'0x2222222222222222222222222222222222222222'});
  let calls=0;const service=createWalletBalances(f.store,{rpc:rpc({getBlock:async()=>({number:1n,timestamp:1n}),readContract:async()=>{calls++;return 0n;}})});
  await service.migrate();await service.state(a);await service.tick();const s=await service.state(a);assert.equal(s.wallets.length,1);assert.equal(s.wallets[0].amountRaw,null);assert.equal(s.wallets[0].status,'unavailable');assert.equal(calls,0);
 }finally{await f.close();}
});
test('parallel workers claim once and a recovered lease rejects an old late result',async()=>{
 const f=await fixture();try{
  const a=owner(),w=agent();await f.store.addAgent(a,w);let started,release,calls=0;
  const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  const old=createWalletBalances(f.store,{rpc:rpc({readContract:async()=>{calls++;started();await gate;return 1n;}})}),next=createWalletBalances(f.store,{rpc:rpc({readContract:async()=>{calls++;return 2n;}})});
  await old.migrate();await old.state(a);const work=old.tick();await ready;await next.tick();assert.equal(calls,1);
  await f.store.query("UPDATE relay_wallet_balances SET lease_until=now()-interval '1 second',next_check_at=now()-interval '1 second'");await next.tick();release();await work;
  assert.equal(calls,2);assert.equal((await old.state(a)).wallets[0].amountRaw,'2');
  const before=(await f.store.query('SELECT next_check_at FROM relay_wallet_balances')).rows[0].next_check_at;
  await old.refresh(a,{agentId:w.id});const after=(await f.store.query('SELECT next_check_at FROM relay_wallet_balances')).rows[0].next_check_at;assert.equal(String(before),String(after));
 }finally{await f.close();}
});
test('Fund again carries only a saved destination and editable fiat preference from a completed live receipt',()=>{
 const w=agent(),order={id:'old-order',source:'live',kind:'checkout',status:'checkout_received',delivery:{finalized:true},agent:w,quote:{pence:500,platform:'wise'},checkoutUrl:'private-old-link'};
 assert.deepEqual(repeatFunding(order,[w]),{agentId:w.id,amount:'5.00',rail:'wise'});
 for(const change of [{source:'fixture'},{fixture:true},{journey:true},{status:'checkout_partial'},{delivery:{finalized:false}},{quote:{pence:100001,platform:'wise'}}])assert.equal(repeatFunding({...order,...change},[w]),null);
 assert.equal(repeatFunding(order,[{...w,address:'0x2222222222222222222222222222222222222222'}]),null);
});
test('HTTP balances require customer sign-in, enforce CSRF/ownership and do not open payment access',async()=>{
 const f=await fixture();let server;try{
  const accounts=createAccounts(f.store),one=await accounts.signup({name:'Alice',email:'alice@example.test',password:'fixture lantern meadow river',acceptSandbox:true}),two=await accounts.signup({name:'Bob',email:'bob@example.test',password:'fixture lantern meadow river',acceptSandbox:true});
  const a=(await accounts.session(one.token)).owner,w=agent();await f.store.addAgent(a,w);
  const balances=createWalletBalances(f.store,{rpc:rpc()});await balances.migrate();
  server=createHostedServer({store:f.store,walletBalances:balances,config:{origin:'https://relay.example',host:'relay.example',testers:[]},paymentsDisabled:true,allowHttpForTests:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const request=(path,token,data,origin='https://relay.example')=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:data?'POST':'GET',headers:{host:'relay.example',origin,'content-type':'application/json',cookie:token?'__Host-relay_sandbox='+token:''}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(body)}));});r.on('error',reject);r.end(data?JSON.stringify(data):undefined);});
  assert.equal((await request('/api/state')).status,401);
  assert.equal((await request('/api/state',one.token)).data.walletBalances.wallets.length,1);
  assert.equal((await request('/api/state',two.token)).data.walletBalances.wallets.length,0);
  const settings={agentId:w.id,enabled:true,threshold:'10',target:'50'};
  assert.equal((await request('/api/wallet-balances/preferences',two.token,settings)).status,404);
  assert.equal((await request('/api/wallet-balances/preferences',one.token,settings,'https://evil.example')).status,403);
  const saved=await request('/api/wallet-balances/preferences',one.token,settings);assert.equal(saved.status,200);assert.equal(saved.data.walletBalances.wallets[0].alertsEnabled,true);assert.equal(saved.data.paymentsDisabled,true);
  assert.equal((await request('/api/checkouts',one.token,{})).status,403);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});

test('a disconnected browser ages out its last fresh snapshot without replacing the amount with zero',()=>{
 const w={status:'fresh',lowBalance:true,amountRaw:'7250000',observedAt:'2026-10-24T12:00:00.000Z'};
 assert.equal(visibleWallet(w,Date.parse('2026-10-24T12:01:00Z')).status,'fresh');
 const stale=visibleWallet(w,Date.parse('2026-10-24T12:04:00Z'));assert.equal(stale.status,'stale');assert.equal(stale.lowBalance,null);assert.equal(stale.amountRaw,'7250000');
});
