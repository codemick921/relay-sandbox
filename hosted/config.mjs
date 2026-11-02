import {partnerDestinations} from '../shared/partner-funding.mjs';
export function config(env=process.env,{worker=false}={}){
 if(env.RELAY_MODE!=='sandbox')throw Error('RELAY_MODE must be sandbox.');
 const livePayments=env.RELAY_LIVE_PAYMENTS==='enabled';
 if(env.RELAY_LIVE_PAYMENTS&&!['enabled','disabled'].includes(env.RELAY_LIVE_PAYMENTS))throw Error('Invalid live payment switch.');
 if(livePayments&&worker)throw Error('Live creation belongs to the web service only.');
 const connectionMode=env.RELAY_PEER_CONNECTION_MODE??'disabled';
 if(!['disabled','receive_only'].includes(connectionMode))throw Error('Unsupported Peer connection mode. Payments remain disabled.');
 const liveKeys=Object.keys(env).filter(k=>k.startsWith('PEER_PAY_LIVE_')&&env[k]);
 if((connectionMode==='disabled'||worker)&&liveKeys.length)throw Error('Live credentials require the web-only receive_only connection.');
 if(worker&&connectionMode!=='disabled')throw Error('The worker cannot connect to live Peer.');
 let liveConnection=null;
 if(connectionMode==='receive_only'){
  const allowed=['PEER_PAY_LIVE_API_KEY','PEER_PAY_LIVE_MERCHANT_ID','PEER_PAY_LIVE_WEBHOOK_SECRET'];
  if(liveKeys.some(k=>!allowed.includes(k))||allowed.some(k=>typeof env[k]!=='string'||!env[k].trim()||env[k].length>4096)||!/^[-a-zA-Z0-9_]{1,128}$/.test(env.PEER_PAY_LIVE_MERCHANT_ID))throw Error('Incomplete or unsupported live connection configuration.');
  if(env.PEER_PAY_LIVE_API_KEY===env.PEER_PAY_SANDBOX_API_KEY||env.PEER_PAY_LIVE_WEBHOOK_SECRET===env.PEER_PAY_SANDBOX_WEBHOOK_SECRET||env.PEER_PAY_LIVE_MERCHANT_ID===env.PEER_PAY_SANDBOX_MERCHANT_ID)throw Error('Live and sandbox connections must be distinct.');
  liveConnection=Object.freeze(Object.defineProperties({mode:'receive_only',environment:'LIVE',merchantId:env.PEER_PAY_LIVE_MERCHANT_ID},{apiKey:{value:env.PEER_PAY_LIVE_API_KEY},secret:{value:env.PEER_PAY_LIVE_WEBHOOK_SECRET}}));
 }
 if(livePayments&&!liveConnection)throw Error('Live payments require an existing verified live connection.');
 const paymentOrigin=worker?null:new URL(env.PUBLIC_ORIGIN??env.RENDER_EXTERNAL_URL??'');
 const origin=worker?null:new URL(env.APP_ORIGIN??paymentOrigin);
 for(const u of [origin,paymentOrigin])if(u&&(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash))throw Error('An HTTPS public origin is required.');
 const legacyOrigin=origin&&paymentOrigin.origin!==origin.origin?paymentOrigin.origin:null;
 let testers;try{testers=JSON.parse(env.SANDBOX_TESTERS);}catch{throw Error('SANDBOX_TESTERS is required.');}
 if(!Array.isArray(testers)||!testers.length||testers.length>10||testers.some(p=>!/^[a-zA-Z0-9_-]{1,40}$/.test(p.label)||!/^[a-f0-9]{64}$/.test(p.sha256hex))||new Set(testers.map(p=>p.label)).size!==testers.length||new Set(testers.map(p=>p.sha256hex)).size!==testers.length)throw Error('Invalid tester configuration.');
 let paymentHealthAdmins=[];try{paymentHealthAdmins=JSON.parse(env.RELAY_PAYMENT_HEALTH_ADMINS??'[]');}catch{throw Error('Invalid payment-health admin configuration.');}
 if(!Array.isArray(paymentHealthAdmins)||paymentHealthAdmins.length>10||new Set(paymentHealthAdmins).size!==paymentHealthAdmins.length||paymentHealthAdmins.some(label=>typeof label!=='string'||!testers.some(t=>t.label===label)))throw Error('Payment-health admins must name configured tester labels.');
 let testInviteAdmins=[];try{testInviteAdmins=JSON.parse(env.RELAY_TEST_INVITE_ADMINS??'[]');}catch{throw Error('Invalid test invitation admin configuration.');}
 if(!Array.isArray(testInviteAdmins)||testInviteAdmins.length>10||new Set(testInviteAdmins).size!==testInviteAdmins.length||testInviteAdmins.some(label=>typeof label!=='string'||!testers.some(t=>t.label===label)))throw Error('Test invitation admins must name configured tester labels.');
 let accountAdmins=[];try{accountAdmins=JSON.parse(env.EUPOVA_ACCOUNT_ADMINS??'[]');}catch{throw Error('Invalid account admin configuration.');}
 if(!Array.isArray(accountAdmins)||accountAdmins.length>10||accountAdmins.some(email=>typeof email!=='string'||email!==email.trim().toLowerCase()||!/^[a-z0-9.!#$%&'*+/?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(email))||new Set(accountAdmins).size!==accountAdmins.length)throw Error('Account admins must be unique normalised email addresses.');
 for(const k of ['DATABASE_URL'])if(!env[k])throw Error(`Missing ${k}.`);
 return {partnerReturns:worker?{}:partnerDestinations(env.EUPOVA_PARTNER_RETURNS),accountAdmins,testInviteAdmins,paymentHealthAdmins,livePayments,trackingSandbox:true,paymentsDisabled:true,providerConnectionsEnabled:false,liveConnection,origin:origin?.origin,host:origin?.host,paymentOrigin:paymentOrigin?.origin,legacyOrigin,testers,webhook:{environment:'SANDBOX',merchantId:env.PEER_PAY_SANDBOX_MERCHANT_ID,secret:env.PEER_PAY_SANDBOX_WEBHOOK_SECRET}};
}
