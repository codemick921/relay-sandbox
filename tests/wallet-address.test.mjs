import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {walletAddressCheck} from '../shared/wallet-address.mjs';
import {walletAddress} from '../server/validation.mjs';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createAccountSecurity} from '../hosted/account-security.mjs';
import {createHostedServer} from '../hosted/server.mjs';
const valid='0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const typo='0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAee';
const password='correct horse meadow lantern';
const input={name:'Agentic wallet',address:valid,network:'base',own:true,currentPassword:password};
const bad=['',null,'bc1qexample','So11111111111111111111111111111111111111112','TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE','0x1234','0x'+'1'.repeat(64),'0x'+'0'.repeat(40),'0x'+'0'.repeat(36)+'dEaD','0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',typo,'ethereum:'+valid+'@1'];
test('offline checks reject malformed, checksum and known invalid destinations without claiming network verification',()=>{
 for(const v of bad){assert.equal(walletAddressCheck(v).valid,false,String(v));assert.throws(()=>walletAddress(v));}
 for(const v of [valid,valid.toLowerCase(),'0x'+valid.slice(2).toUpperCase(),'0x'+'1'.repeat(40)]){assert.deepEqual(walletAddressCheck(v),{valid:true,code:'format-checked',message:'Address format checked'});assert.equal(walletAddress(v),v);}
});
test('customer wallet create and edit reject invalid destinations and preserve existing records',async()=>{
 const f=await fixture();try{const accounts=createAccounts(f.store),a=await accounts.signup({email:'wallet-check@example.test',name:'Check Person',password,acceptSandbox:true}),security=createAccountSecurity(f.store,accounts),owner='customer:'+a.account.id;
 for(const value of bad)await assert.rejects(security.saveWallet({...input,address:value},a.token));
 for(const v of [{network:'ethereum'},{own:false}])await assert.rejects(security.saveWallet({...input,...v},a.token));
 assert.equal((await f.store.state(owner)).agents.length,0);
 const {id}=await security.saveWallet(input,a.token),before=(await f.store.state(owner)).agents;
 await assert.rejects(security.saveWallet({...input,id,address:typo,expectedAddress:valid,expectedName:input.name},a.token,{update:true}),/checksum/);
 assert.deepEqual((await f.store.state(owner)).agents,before);
 await security.saveWallet({...input,id,address:'0x'+'2'.repeat(40),expectedAddress:valid,expectedName:input.name},a.token,{update:true});
 assert.equal((await f.store.state(owner)).agents[0].address,'0x'+'2'.repeat(40));assert.ok(await accounts.session(a.token));
 }finally{await f.close();}
});
test('HTTP wallet save enforces validation even with client bypass and makes no provider call',async()=>{
 const f=await fixture();let server;try{const accounts=createAccounts(f.store),a=await accounts.signup({email:'wallet-http@example.test',name:'HTTP Person',password,acceptSandbox:true});let calls=0;
 server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},allowHttpForTests:true,paymentsDisabled:true,pay:{readiness:async()=>{calls++;throw Error('provider called');}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const req=body=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/api/agents',method:'POST',headers:{host:'relay.example',origin:'https://relay.example','content-type':'application/json',cookie:'__Host-relay_sandbox='+a.token}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));});r.on('error',reject);r.end(JSON.stringify(body));});
 assert.equal((await req({...input,address:typo})).status,400);assert.equal((await req({...input,network:'solana'})).status,400);assert.equal((await req({...input,own:false})).status,400);
 assert.equal((await req(input)).status,200);assert.equal((await f.store.state('customer:'+a.account.id)).agents.length,1);assert.equal(calls,0);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
