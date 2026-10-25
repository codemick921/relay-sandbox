import {createAccountMail} from './account-mail.mjs';

// Optional adapter, inactive unless explicitly configured. No credentials are
// read from disk and no provider request is made during startup/readiness checks.
export function configuredAccountMail(store,env=process.env,{fetchImpl=fetch}={}){
 if(env.ACCOUNT_EMAIL_ENABLED!=='true')return createAccountMail(store);
 const origin=env.PUBLIC_ORIGIN??env.RENDER_EXTERNAL_URL;
 const from=env.ACCOUNT_EMAIL_FROM?.replace(/^Relay </,'Eupova <'),key=env.RESEND_API_KEY;
 if(!from||!/^Eupova <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/.test(from)||/[\r\n]/.test(from)||!key)throw Error('Account email sender configuration is incomplete.');
 return createAccountMail(store,{enabled:true,origin,deliver:async({id,to,subject,text})=>{
  const response=await fetchImpl('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','Idempotency-Key':id},body:JSON.stringify({from,to:[to],subject,text})});
  if(!response.ok)throw Error('Email acceptance not confirmed.');
  const result=await response.json();return {id:result.id};
 }});
}
