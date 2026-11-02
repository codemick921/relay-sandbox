// Server-side example. No automatic execution, payment or checkout methods.
export function eupovaPartnerClient({key,fetchImpl=fetch}){
 if(typeof key!=='string'||!/^eupova_agent_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(key))throw Error('Store a request-only connection key in server secrets.');
 const base='https://app.eupova.com';
 const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
 async function call(path,options){
  const res=await fetchImpl(base+path,{...options,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${key}`,...options?.headers}});
  if(!res.ok)throw Object.assign(Error(`Eupova returned HTTP ${res.status}. Reconcile using the same request key; do not create a new request automatically.`),{status:res.status});
  return res.json();
 }
 return Object.freeze({
  request({idempotencyKey,purpose,targetUsdc,expiresInHours=24}){
   if(!uuid(idempotencyKey))throw Error('Persist a UUID for this logical request before submitting.');
   return call('/api/agent/v1/funding-requests',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify({purpose,targetUsdc,expiresInHours})});
  },
  status(id){if(!uuid(id))throw Error('Invalid funding request ID.');return call('/api/agent/v1/funding-requests/'+id,{method:'GET'});}
 });
}
