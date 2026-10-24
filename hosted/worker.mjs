import {migrateWhenReady} from './startup.mjs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createPool,createStore,orderView} from './db.mjs';
import {config as readConfig} from './config.mjs';
import {createSandboxPayService} from '../server/pay-sandbox.mjs';
export function createWorker({store,pay=createSandboxPayService(),id=randomUUID()}){
 let running=false,stopping=false,failures=0,pauseUntil=0;
 return {
  async tick(){if(running||stopping)return;running=true;try{
   await store.heartbeat(id);if(Date.now()<pauseUntil)return;
   for(let n=0;n<5&&!stopping;n++){
    const claim=await store.claimNext(id);if(!claim)break;
    try{
     const order=orderView(claim);
     if(!claim.provider_id){await store.apply(claim,await pay.recover(order,claim.recovery_id),{creation:true});}
     else await store.apply(claim,await pay.refresh(order));
     failures=0;
    }catch{await store.fail(claim);if(++failures>=5){pauseUntil=Date.now()+60000;break;}}
    await store.heartbeat(id);
   }
  }finally{running=false;}},
  async stop(){stopping=true;while(running)await new Promise(r=>setTimeout(r,100));},
  get running(){return running;}
 };
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 readConfig(process.env,{worker:true});const store=createStore(createPool());
 // Both processes can start first; the migration lock serialises schema installation.
 await migrateWhenReady(store);const worker=createWorker({store});const timer=setInterval(()=>worker.tick().catch(()=>console.error('Sandbox worker temporarily unavailable.')),15000);
 await worker.tick();let closing=false;
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(closing)return;closing=true;clearInterval(timer);const deadline=setTimeout(()=>process.exit(1),25000);deadline.unref();await worker.stop();await store.close();process.exit(0);});
 setInterval(()=>store.maintenance().catch(()=>{}),3600000).unref();
}
