// Explicit local-only fixture runner. Never loads .env or creates a real checkout.
import '../tests/fixtures/offline-guard.mjs';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createStore,digest} from './db.mjs';
import {createLiveStore} from './live-store.mjs';
import {createLiveWorker} from './live-worker.mjs';
import {createHostedServer} from './server.mjs';
import {verifyPayDelivery} from '../server/pay-delivery.mjs';
import {local,remote,payment,receipt,rpc} from '../tests/fixtures/live-evidence.mjs';

const database=new URL(process.env.RELAY_PREVIEW_DATABASE_URL??'');
if(!['postgres:','postgresql:'].includes(database.protocol)||database.hostname!=='127.0.0.1'||database.search)throw Error('Use a dedicated PostgreSQL test database on 127.0.0.1, without query options.');
const port=Number(process.env.RELAY_PREVIEW_PORT??4322);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Choose a local unprivileged port.');
const schema='relay_preview_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:database.href});
await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new pg.Pool({connectionString:database.href,options:`-c search_path=${schema}`,max:6});
try{
const store=createStore(pool),tracking=createLiveStore(pool,{merchantId:'merchant'});
await store.migrate();await tracking.migrate();
const cases=[['alice','received','Research assistant'],['alice','confirming','Travel assistant'],['alice','partial','Shopping assistant'],['alice','review','Calendar assistant'],['bob','received','Bob’s private example']];
const fixtures=new Map(),agents=new Map();
for(const [i,[owner,stage,name]] of cases.entries()){
 const o={...local(),id:randomUUID(),providerOrderId:'fixture-'+i,requestedUsdcAmount:'12.5',agent:{...local().agent,id:randomUUID(),name,network:'Base',token:'USDC'}};
 if(!agents.has(owner)){await store.addAgent(owner,o.agent);agents.set(owner,o.agent);}
 o.agent=agents.get(owner);await tracking.bindTrustedOrder(owner,o);
 const p={...payment(),id:'fixture-payment-'+i,orderId:o.providerOrderId,railIdentifier:'0x'+(i+1).toString(16).padStart(64,'0'),fulfillTransaction:'0x'+(i+11).toString(16).padStart(64,'0')};p.quote={...p.quote,intentHash:p.railIdentifier};
 fixtures.set(o.providerOrderId,{stage,p,checks:0});
}
const worker=createLiveWorker({store:tracking,pay:{refresh:async o=>{
 const f=fixtures.get(o.providerOrderId);if(!f)throw Error('Unknown fixture');
 if(f.stage==='review'){
  const {TrackingReviewError}=await import('../server/pay-readonly.mjs');throw new TrackingReviewError('Fixture review');
 }
 const pending=f.stage==='confirming'&&f.checks++===0;
 const provider={...remote(),id:o.providerOrderId,notes:{relayOrderId:o.id},...f.stage==='partial'?{status:'PARTIALLY_FULFILLED',remainingUsdcAmount:'0.5'}:{}};
 const chain=rpc({getTransactionReceipt:async()=>receipt(f.p),getBlock:async({blockTag})=>({hash:receipt(f.p).blockHash,number:blockTag==='finalized'&&pending?119n:120n})});
 const v=await verifyPayDelivery(o,provider,[f.p],{rpc:chain});
 return {...v,providerStatus:provider.status,chargebackStatus:'NONE',checkedAt:v.verification.checkedAt};
}}});
await worker.tick();
// Leave examples stable until an authenticated user explicitly requests a refresh.
await tracking.query("UPDATE relay_live_orders SET next_check_at=now()+interval '1 day'");
const origin=`http://127.0.0.1:${port}`,config={origin,host:new URL(origin).host,testers:['alice','bob'].map(label=>({label,sha256hex:digest('relay-preview-'+label)}))};
const server=createHostedServer({store,config,pay:{readiness:async()=>({ready:false})},tracking:{store:tracking,simulated:true},paymentsDisabled:true,localPreview:true});
const timer=setInterval(()=>worker.tick().catch(()=>console.error('Local fixture tracking unavailable.')),1000);
server.listen(port,'127.0.0.1',()=>console.log(`Local simulated preview: ${origin}\nTester codes: relay-preview-alice / relay-preview-bob\nReal payments and external connections are disabled.`));
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{
 if(stopping)return;stopping=true;clearInterval(timer);await worker.stop();await new Promise(r=>server.close(r));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();process.exit(0);
});

}catch(error){await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();throw error;}
