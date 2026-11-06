import {createAccountMail} from './account-mail.mjs';

// Optional adapter, inactive unless explicitly configured. No credentials are
// read from disk and no provider request is made during startup/readiness checks.
export function configuredAccountMail(store,env=process.env,{fetchImpl=fetch}={}){
 if(env.ACCOUNT_EMAIL_ENABLED!=='true')return createAccountMail(store);
 const origin=env.APP_ORIGIN??env.PUBLIC_ORIGIN??env.RENDER_EXTERNAL_URL;
 const from=env.ACCOUNT_EMAIL_FROM?.replace(/^Relay </,'Eupova <'),key=env.RESEND_API_KEY;
 if(!from||!/^Eupova <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/.test(from)||/[\r\n]/.test(from)||!key)throw Error('Account email sender configuration is incomplete.');
 return createAccountMail(store,{enabled:true,origin,deliver:async({id,attempt=1,to,subject,text})=>{
  // The attempt number is part of the idempotency key: a retry must be a new send, because each attempt builds a fresh
  // token and the provider would otherwise replay the first accepted message with a link that no longer works.
  const response=await fetchImpl('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','Idempotency-Key':`${id}:${attempt}`},body:JSON.stringify({from,to:[to],subject,text})});
  if(!response.ok){
   // Keep the provider's own answer: the status identifies a bad key, an unverified sender or a rate limit, which is
   // exactly what tells an operator what to change.
   const body=await response.text().catch(()=> '');
   throw Error(`Email acceptance not confirmed: HTTP ${response.status}${body?` ${body.replace(/\s+/g,' ').slice(0,160)}`:''}`);
  }
  const result=await response.json();return {id:result.id};
 }});
}
