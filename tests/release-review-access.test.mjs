import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prod,DEST} from './fixtures/prod-server.mjs';

// Independent production-boundary check: disabling a customer must also stop its connected tool.
test('release review: disabled customers cannot continue using live CLI credentials', async () => {
 const s=await prod({netId:'base'});
 try {
  const cookie=await s.signup('disabled-tool-'+randomUUID()+'@example.invalid');
  const account=(await s.call('state',undefined,cookie)).json.account;
  const owner='customer:'+account.id;
  await s.cw.createWallet(owner,{label:'Review wallet',requestId:randomUUID()});
  s.st.wallets[owner]={providerRef:'w-review',address:'0x'+'a'.repeat(40),state:'ready'};
  await s.cw.finishSetup(owner);s.st.usdc[owner]=50000000n;s.st.eth[owner]=1000000000000000000n;
  const enrol=await s.cw.tools.enrolStart({name:'Review tool',ip:'127.0.0.1'});
  await s.cw.tools.approveEnrolment(owner,{userCode:enrol.userCode});
  const got=await s.cw.tools.enrolPoll({enrolmentId:enrol.enrolmentId,deviceSecret:enrol.deviceSecret,ip:'127.0.0.1'});
  const read=()=>fetch(s.origin+'/api/wallet-tool/v1/allowance',{headers:{authorization:'Bearer '+got.token}});
  assert.equal((await read()).status,200);
  await s.f.store.query('UPDATE relay_customers SET disabled=true WHERE id=$1',[account.id]);
  assert.ok([401,403].includes((await read()).status),'a disabled customer no longer authorises live CLI data access');
  const r=await fetch(s.origin+'/api/wallet-tool/v1/payments',{method:'POST',headers:{authorization:'Bearer '+got.token,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({service:'Review API',destination:DEST,amount:'1'})});
  assert.ok([401,403].includes(r.status),'a disabled customer cannot create CLI payment requests');
 }finally{await s.close();}
});
