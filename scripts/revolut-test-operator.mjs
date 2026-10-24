// Run manually in the existing Render service. Never print secrets or checkout links.
import {config} from '../hosted/config.mjs';
import {createPool,createStore} from '../hosted/db.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createRestrictedTestPolicy} from '../hosted/restricted-test.mjs';
import {createRevolutPolicy} from '../hosted/revolut-test.mjs';
import {createLiveStore} from '../hosted/live-store.mjs';
import {createRevolutOperator} from '../hosted/revolut-operator.mjs';
const [action,json]=process.argv.slice(2),input=JSON.parse(json??'{}');
if(!['prepare','provision','create','reconcile','status','revoke'].includes(action)||!/^customer:[a-f0-9-]{36}$/.test(input.owner??''))throw Error('Specify the verified customer owner and explicit operator action.');
const cfg=config(),connection=cfg.liveConnection;if(!connection)throw Error('Existing live connection required.');
const pool=createPool(),base=createStore(pool),drafts=createFundingDrafts(base),policy=createRevolutPolicy(base),tracker=createLiveStore(pool,{merchantId:connection.merchantId});
try{
 await drafts.migrate();await createRestrictedTestPolicy(base).migrate();await policy.migrate();await tracker.migrate();
 const operator=createRevolutOperator({base,drafts,policy,tracker,apiKey:connection.apiKey,merchantId:connection.merchantId,origin:cfg.origin});
 let result;
 if(action==='prepare')result=await drafts.prepare(input.owner,{agentId:input.agentId,amount:input.amount,requestId:input.requestId,rail:'revolut',confirm:input.confirm});
 if(action==='provision')result=await operator.provision(input.owner,input.id,input);
 if(action==='create')result=await operator.start(input.owner,input.id);
 if(action==='reconcile')result=await operator.reconcile(input.owner,input.id,input.providerId);
 if(action==='status')result=await policy.status(input.owner);
 if(action==='revoke'){await base.query('UPDATE relay_revolut_policy SET revoked=true WHERE owner=$1 AND draft_id=$2',[input.owner,input.id]);result=await policy.status(input.owner);}
 console.log(JSON.stringify(result));
}finally{await pool.end();}
