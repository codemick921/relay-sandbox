import test from 'node:test';
import assert from 'node:assert/strict';
import {dialogPath} from '../src/dialog-navigation.mjs';
import {randomUUID} from 'node:crypto';
import {partnerReviewLink,partnerDestinations,fundingButtonMarkup} from '../shared/partner-funding.mjs';
import {resumeTarget,resolveResume} from '../src/payment-resume.mjs';
import {eupovaPartnerClient} from '../examples/partner-client.mjs';
const id='11111111-1111-4111-8111-111111111111';
test('partner review links carry only a reference and resolve only in owner-scoped account state',()=>{
 const link=partnerReviewLink('https://app.eupova.com',id);assert.equal(link,`https://app.eupova.com/#request=${id}`);
 const target=resumeTarget(new URL(link));assert.deepEqual(target,{kind:'agent-request',id});
 assert.deepEqual(resolveResume(target,{account:{id:'owner'},agentFundingRequests:[{id}]}),target);
 for(const state of [{account:null,agentFundingRequests:[{id}]},{account:{id:'other'},agentFundingRequests:[]}])assert.deepEqual(resolveResume(target,state),{kind:'resume-unavailable'});
 for(const bad of ['javascript:alert(1)','http://example.com','https://u:p@example.com','https://example.com/redirect','https://example.com/?return=evil'])assert.throws(()=>partnerReviewLink(bad,id));
 assert.throws(()=>partnerReviewLink('https://app.eupova.com','bad'));
 assert.deepEqual(resumeTarget({hash:'#request='+id+'&return=https://evil.example'}),{kind:'invalid'});
 assert.deepEqual(resumeTarget({hash:'#request='+id,search:'?return=https://evil.example'}),target);
});
test('button builder rejects credentials, extra params, markup injection and unrelated domains',()=>{
 assert.match(fundingButtonMarkup(partnerReviewLink('https://app.eupova.com',id)),/noopener noreferrer/);
 for(const u of [`https://evil.example/#request=${id}`,`https://app.eupova.com/?key=secret#request=${id}`,`https://app.eupova.com/#request=${id}"><script>`,`https://app.eupova.com/#funding=${id}`])assert.throws(()=>fundingButtonMarkup(u));
});
test('return destination configuration is empty by default and strict, exact, connection-scoped',()=>{
 assert.equal(Object.keys(partnerDestinations()).length,0);
 const config=partnerDestinations(JSON.stringify({[id]:{name:'Research platform',url:'https://partner.example/funding'}}));
 assert.equal(config[id].url,'https://partner.example/funding');assert.equal(config[randomUUID()],undefined);
 for(const url of ['http://partner.example/','https://user:password@partner.example/','https://partner.example/?redirect=evil','https://partner.example/#secret','https://127.0.0.1/','https://[::1]/','https://localhost/','https://foo.local/','https://partner.example:8443/','https://partner.example/\\evil','javascript:alert(1)'])assert.throws(()=>partnerDestinations(JSON.stringify({[id]:{name:'Demo',url}})));
 for(const raw of ['null','[]','bad',JSON.stringify({bad:{name:'Demo',url:'https://partner.example/'}}),JSON.stringify({[id]:{name:'Demo',url:'https://partner.example/',extra:true}})])assert.throws(()=>partnerDestinations(raw));
});
test('server client sends only request/status calls, never cookies, follows no redirect and does not blindly retry',async()=>{
 const calls=[],key='eupova_agent_'+id+'.'+'a'.repeat(43),client=eupovaPartnerClient({key,fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id})};}});
 await client.request({idempotencyKey:id,purpose:'Research',targetUsdc:'25'});await client.status(id);
 assert.equal(calls.length,2);assert.equal(calls[0].options.headers['Idempotency-Key'],id);assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.Cookie,undefined);assert.equal(JSON.parse(calls[0].options.body).targetUsdc,'25');assert.equal(calls[1].options.method,'GET');
 assert.throws(()=>client.status('../state'));assert.throws(()=>client.request({idempotencyKey:'bad'}));
 let count=0;const failed=eupovaPartnerClient({key,fetchImpl:async()=>{count++;return {ok:false,status:429};}});await assert.rejects(failed.status(id),/429/);assert.equal(count,1);
});

test('button generator rejects URL credentials',()=>{assert.throws(()=>fundingButtonMarkup(`https://user:password@app.eupova.com/#request=${id}`));});

test('request navigation retains a reloadable review link',()=>{assert.equal(dialogPath({kind:'agent-request',id},'/'),'/#request='+id);assert.equal(dialogPath(null,'/'),'/');});
