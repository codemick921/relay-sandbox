import {randomUUID} from 'node:crypto';
import {liveOrderView} from './live-store.mjs';
import {TrackingReviewError} from '../server/pay-readonly.mjs';

// Dependency-injected: importing this module cannot start polling or use a key.
export function createLiveWorker({store,pay,id=randomUUID(),clock=Date.now,maxBatch=5}){
 if(!store||typeof pay?.refresh!=='function'||pay.create)throw Error('A read-only tracking service is required.');
 let running=false,stopping=false,failures=0,pauseUntil=0;
 return {
  async tick(){
   if(running||stopping)return;running=true;
   try{
    await store.heartbeat(id);if(clock()<pauseUntil)return;
    for(let n=0;n<maxBatch&&!stopping;n++){
     const claim=await store.claimNext();if(!claim)break;
     try{await store.apply(claim,await pay.refresh(liveOrderView(claim)));failures=0;}
     catch(error){await store.fail(claim,{review:error instanceof TrackingReviewError});if(++failures>=5){pauseUntil=clock()+60000;break;}}
     await store.heartbeat(id);
    }
   }finally{running=false;}
  },
  async stop(){stopping=true;while(running)await new Promise(r=>setTimeout(r,50));},
  get running(){return running;}
 };
}
