import {createBuyerSessionReader} from './buyer-auth-session.mjs';
import {createTargetCalculator,calculatorInput} from './target-calculator.mjs';
import {QuoteError} from './direct-quote.mjs';
export const calculatorPath='/api/funding-calculator/quotes';
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Cookie, Origin','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));return true;};
export function createTargetCalculatorHttp({origin,enabled=()=>false,resolveSession,rate,calculator}={}){
 const handler=async(req,res)=>{
  if(String(req.url).split('?')[0]!==calculatorPath)return false;
  if(!enabled())return send(res,404,{error:'calculator_disabled'});
  try{
   const site=new URL(origin);
   if(site.protocol!=='https:'||origin!==site.origin||!resolveSession||!rate||!calculator)return send(res,503,{error:'calculator_unavailable'});
   if(req.url!==calculatorPath||req.headers.host!==site.host||req.headers['x-forwarded-proto']!=='https'||req.headers.origin!==origin||req.headers['sec-fetch-site']!=='same-origin'||req.headers.authorization||req.headers['content-encoding'])return send(res,403,{error:'request_rejected'});
   if(req.method!=='POST')return send(res,405,{error:'method_not_allowed'});
   if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))return send(res,415,{error:'invalid_content_type'});
   await rate('calculator:global',60,60);
   const matches=String(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Host-relay_sandbox='));
   const token=matches.length===1?matches[0].slice('__Host-relay_sandbox='.length):null;
   const session=token&&/^[a-f0-9]{64}$/.test(token)&&await resolveSession(token);
   if(!session)return send(res,401,{error:'sign_in_required'});
   await rate('calculator:'+session.owner,6,60);
   let size=0;const chunks=[];
   for await(const c of req.iterator({destroyOnReturn:false})){size+=c.length;if(size>512){req.resume();return send(res,413,{error:'request_too_large'});}chunks.push(c);}
   let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));calculatorInput(input);}catch{return send(res,400,{error:'invalid_target_or_method'});}
   const result=await calculator.quotes(input);
   const current=await resolveSession(token);
   if(!enabled()||!current||current.owner!==session.owner||current.binding!==session.binding)return send(res,403,{error:'session_changed'});
   return send(res,200,result);
  }catch(e){const limited=e.status===429;return send(res,limited?429:e instanceof QuoteError?400:503,{error:limited?'too_many_requests':'calculator_unavailable'});}
 };
 handler.available=()=>enabled()===true;
 return handler;
}
export function configuredTargetCalculator({origin,store,env=process.env}={}){
 const enabled=()=>env.EUPOVA_TARGET_CALCULATOR_ENABLED==='true';
 if(!enabled())return createTargetCalculatorHttp({enabled});
 return createTargetCalculatorHttp({origin,enabled,resolveSession:createBuyerSessionReader(store),rate:(...args)=>store.rate(...args),calculator:createTargetCalculator()});
}
