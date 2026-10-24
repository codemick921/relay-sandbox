import {InputError} from '../server/validation.mjs';
import {verifyWebhook} from '../server/pay-webhooks.mjs';
import {TrackingReviewError} from '../server/pay-readonly.mjs';
import {liveOrderView} from './live-store.mjs';

const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data));return true;};
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>262144)throw new InputError('Request too large.',413);chunks.push(chunk);}return Buffer.concat(chunks);}

export const presentTrackedOrder=(order,simulated=false)=>({...order,tracking:true,...simulated?{source:'fixture',fixture:true,verification:order.verification?{...order.verification,environment:'SIMULATED',simulated:true}:undefined}: {}});

// Webhooks are optional and disabled unless explicitly supplied. Session auth
// and durable rate limits are required even when only read routes are mounted.
export function createLiveTrackingHandler({store,origin,webhook,authenticate,rateLimit,allowHttpForTests=false,simulated=false,localPreview=false,prefix='/api/live-tracking'}){
 if(!['/api/live-tracking','/api/wallet-tracking'].includes(prefix))throw Error('Unsupported tracking prefix.');
 const parsed=new URL(origin);
 const loopback=localPreview&&simulated&&parsed.protocol==='http:'&&parsed.hostname==='127.0.0.1';
 if((parsed.protocol!=='https:'&&!loopback)||parsed.pathname!=='/'||parsed.search||parsed.hash||parsed.username||parsed.password||(webhook&&(webhook.environment!=='LIVE'||!webhook.secret||!webhook.merchantId))||typeof authenticate!=='function'||typeof rateLimit!=='function'||(simulated&&webhook))throw Error('Live tracking requires HTTPS, authentication, rate limits and an explicit valid webhook connection when enabled.');
 return async(req,res)=>{
  const pathname=new URL(req.url,origin).pathname;
  if(pathname!=='/api/webhooks/peer/live'&&!pathname.startsWith(prefix+'/'))return false;
  try{
   if(req.headers.host!==parsed.host)throw new InputError('Unexpected host.',421);
   if(!allowHttpForTests&&!loopback&&req.headers['x-forwarded-proto']!=='https')throw new InputError('HTTPS required.',400);
   if(pathname==='/api/webhooks/peer/live'){
    if(!webhook)throw new InputError('Not found.',404);
    if(req.method!=='POST')throw new InputError('Method not allowed.',405);
    if(!String(req.headers['content-type']).startsWith('application/json'))throw new InputError('JSON required.',415);
    const event=verifyWebhook(await body(req),req.headers,webhook);
    return send(res,202,{accepted:true,...await store.accept(event)});
   }
   if(req.headers['sec-fetch-site']==='cross-site')throw new InputError('Cross-site access blocked.',403);
   if(!['GET','POST'].includes(req.method))throw new InputError('Method not allowed.',405);
   if(req.method==='POST'&&(req.headers.origin!==parsed.origin||!String(req.headers['content-type']).startsWith('application/json')))throw new InputError('Same-origin JSON required.',403);
   // Authentication must resolve the owner server-side. Never read it from URL/body.
   const owner=await authenticate(req);if(typeof owner!=='string'||!owner)throw new InputError('Sign in to see your payments.',401);
   await rateLimit(owner,req.method==='GET'?'read':'refresh');
   if(pathname===prefix+'/orders'&&req.method==='GET')return send(res,200,{orders:(await store.state(owner)).orders.map(o=>presentTrackedOrder(o,simulated)),simulated,worker:await store.health()});
   const match=pathname.slice(prefix.length).match(/^\/orders\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/(receipt|refresh))?$/);
   if(!match)throw new InputError('Not found.',404);
   const row=await store.owned(owner,match[1]);
   if(match[2]==='refresh'&&req.method==='POST'){await store.schedule(owner,row.id);return send(res,202,{scheduled:true,id:row.id});}
   if(req.method!=='GET'||match[2]==='refresh')throw new InputError('Method not allowed.',405);
   if(match[2]==='receipt'){
    if(row.review_required||row.status!=='checkout_received'||!row.result.delivery?.finalized)throw new InputError('A complete wallet receipt is not confirmed.',409);
    return send(res,200,{simulated,environment:simulated?'SIMULATED':'LIVE',orderId:row.id,providerOrderId:row.provider_id,delivery:row.result.delivery,checkedAt:row.result.checkedAt,trackingError:row.result.trackingError??null,chargebackStatus:row.result.chargebackStatus});
   }
   return send(res,200,presentTrackedOrder(liveOrderView(row),simulated));
  }catch(e){return send(res,e instanceof InputError?e.status:e instanceof TrackingReviewError?409:503,{error:e instanceof InputError?e.message:e instanceof TrackingReviewError?'Conflicting payment evidence requires review.':'Tracking is temporarily unavailable. Saved records are retained.'});}
 };
}
