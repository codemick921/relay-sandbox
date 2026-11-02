// Local sample adapter only. No fetch, storage, credentials or production imports.
export function createSampleConnection({onChange,scenario='success',schedule=setTimeout,cancelTimer=clearTimeout}={}){
 let generation=0,disposed=false,timers=[];
 const clear=()=>{generation++;timers.forEach(cancelTimer);timers=[];};
 const publish=state=>{if(!disposed)onChange(state);};
 return {
  connect(){if(disposed)return;clear();const current=generation;publish('connecting');timers.push(schedule(()=>{if(disposed||current!==generation)return;publish(scenario==='declined'?'rejected':scenario==='unavailable'?'error':'connected');if(scenario==='expiry')timers.push(schedule(()=>{if(!disposed&&current===generation)publish('expired');},4000));},1000));},
  disconnect(){if(disposed)return;clear();publish('disconnected');},
  dispose(){disposed=true;clear();}
 };
}
