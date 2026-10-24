// Retry only transient database readiness failures; never conceal schema/auth errors.
export async function migrateWhenReady(store,{attempts=24,delay=()=>new Promise(r=>setTimeout(r,5000)),notify=()=>console.error('Waiting for the private database to become ready.')}={}){
 for(let attempt=1;attempt<=attempts;attempt++){
  try{await store.migrate();return;}
  catch(e){if(attempt===attempts||!['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EAI_AGAIN','57P03','08006'].includes(e.code))throw e;notify();await delay();}
 }
}
