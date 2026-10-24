export function config(env=process.env,{worker=false}={}){
 if(env.RELAY_MODE!=='sandbox')throw Error('RELAY_MODE must be sandbox.');
 if(env.PEER_PAY_LIVE_API_KEY||env.PEER_PAY_LIVE_READ_API_KEY||env.PEER_PAY_LIVE_WEBHOOK_SECRET)throw Error('Live credentials are forbidden in the hosted sandbox.');
 const origin=worker?null:new URL(env.PUBLIC_ORIGIN??env.RENDER_EXTERNAL_URL??'');
 if(origin&&(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash))throw Error('An HTTPS public origin is required.');
 let testers;try{testers=JSON.parse(env.SANDBOX_TESTERS);}catch{throw Error('SANDBOX_TESTERS is required.');}
 if(!Array.isArray(testers)||!testers.length||testers.length>10||testers.some(p=>!/^[a-zA-Z0-9_-]{1,40}$/.test(p.label)||!/^[a-f0-9]{64}$/.test(p.sha256hex))||new Set(testers.map(p=>p.label)).size!==testers.length||new Set(testers.map(p=>p.sha256hex)).size!==testers.length)throw Error('Invalid tester configuration.');
 for(const k of ['DATABASE_URL','PEER_PAY_SANDBOX_API_KEY','PEER_PAY_SANDBOX_MERCHANT_ID','PEER_PAY_SANDBOX_WEBHOOK_SECRET'])if(!env[k])throw Error(`Missing ${k}.`);
 return {origin:origin?.origin,host:origin?.host,testers,webhook:{environment:'SANDBOX',merchantId:env.PEER_PAY_SANDBOX_MERCHANT_ID,secret:env.PEER_PAY_SANDBOX_WEBHOOK_SECRET}};
}
