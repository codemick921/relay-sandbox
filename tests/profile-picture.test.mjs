import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {randomUUID} from 'node:crypto';import {deflateSync} from 'node:zlib';import {fixture} from './fixtures/account-store.mjs';import {createAccounts} from '../hosted/accounts.mjs';import {createHostedServer} from '../hosted/server.mjs';import {normaliseProfilePicture,createProfilePictures} from '../hosted/profile-picture.mjs';
function crc(b){let c=0xffffffff;for(const n of b){c^=n;for(let i=0;i<8;i++)c=c&1?(c>>>1)^0xedb88320:c>>>1;}return(c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);t.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([t,data])),b.length-4);return b;}
function png({width=128,height=128,metadata=false,filter=0,inflateExtra=false,animated=false}={}){const h=Buffer.alloc(13);h.writeUInt32BE(width);h.writeUInt32BE(height,4);h[8]=8;h[9]=6;const pixels=Buffer.alloc((128*4+1)*128+(inflateExtra?10000:0),80);for(let y=0;y<128;y++)pixels[y*513]=filter;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),...(metadata?[chunk('tEXt',Buffer.from('Location\0private metadata'))]:[]),...(animated?[chunk('acTL',Buffer.alloc(8))]:[]),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);}
const data=b=>'data:image/png;base64,'+b.toString('base64');
test('profile PNG sanitisation strips metadata and rejects malformed, oversized, animated and non-image inputs',()=>{
 const clean=normaliseProfilePicture(data(png({metadata:true})));assert(!Buffer.from(clean.slice(22),'base64').includes(Buffer.from('private metadata')));assert.equal(normaliseProfilePicture(clean),clean);assert.equal(normaliseProfilePicture(null),null);
 const corrupt=png();corrupt[20]^=1;
 for(const bad of [undefined,'https://example.test/picture.png','data:image/svg+xml;base64,PHN2Zz4=',data(Buffer.from('not an image')),data(corrupt),data(Buffer.concat([png(),Buffer.from('trailing')])),data(png({width:129})),data(png({filter:5})),data(png({inflateExtra:true})),data(png({animated:true})),'data:image/png;base64,'+'A'.repeat(110001)])assert.throws(()=>normaliseProfilePicture(bad));
});
test('profile migration and persistence preserve customer credentials, wallets and orders, isolate accounts and support removal',async()=>{
 const f=await fixture();try{const accounts=createAccounts(f.store),a=await accounts.signup({email:'profile-a@example.test',name:'Alice Person',password:'correct horse meadow lantern',acceptSandbox:true}),b=await accounts.signup({email:'profile-b@example.test',name:'Bob Person',password:'correct horse meadow lantern',acceptSandbox:true});
 const owner='customer:'+a.account.id,id=randomUUID();await f.store.addAgent(owner,{id,name:'Saved wallet',address:'0x1111111111111111111111111111111111111111'});await f.store.createOrder(owner,{requestId:randomUUID(),agentId:id,amount:500});
 const before=(await f.store.query('SELECT * FROM relay_customers ORDER BY id')).rows,wallets=(await f.store.state(owner)).agents,orders=(await f.store.state(owner)).orders;
 const profiles=createProfilePictures(f.store);assert.deepEqual(await profiles.read(a.account.id),{picture:null});const saved=await profiles.save(a.account.id,{picture:data(png())});assert.ok(saved.picture);assert.deepEqual(await profiles.read(b.account.id),{picture:null});
 await f.store.migrate();await f.store.migrate();assert.deepEqual(await createProfilePictures(f.store).read(a.account.id),saved);
 assert.deepEqual((await f.store.query('SELECT * FROM relay_customers ORDER BY id')).rows,before);assert.deepEqual((await f.store.state(owner)).agents,wallets);assert.deepEqual((await f.store.state(owner)).orders,orders);
 await assert.rejects(profiles.save(a.account.id,{picture:null,customerId:b.account.id}),/Invalid profile/);
 await profiles.save(a.account.id,{picture:null});assert.deepEqual(await profiles.read(a.account.id),{picture:null});assert.ok(await accounts.session(a.token));
 }finally{await f.close();}
});
test('profile HTTP route enforces customer session, origin, payload limits and privacy without payment calls',async()=>{
 const f=await fixture();let server;try{const accounts=createAccounts(f.store),a=await accounts.signup({email:'profile-http@example.test',name:'HTTP Person',password:'correct horse meadow lantern',acceptSandbox:true});let calls=0;server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},allowHttpForTests:true,paymentsDisabled:true,pay:{readiness:async()=>{calls++;throw Error('provider called');}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const req=(path,body,token=a.token,origin='https://relay.example',method=body?'POST':'GET')=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:'relay.example',origin,'content-type':'application/json',cookie:token?'__Host-relay_sandbox='+token:''}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text),headers:res.headers}));});r.on('error',reject);r.end(body?JSON.stringify(body):undefined);});
 assert.equal((await req('/api/profile',undefined,null)).status,401);
 assert.equal((await req('/api/profile',{picture:data(png())},a.token,'https://evil.example')).status,403);
 assert.equal((await req('/api/profile',{picture:'data:image/svg+xml;base64,PHN2Zz4='})).status,400);
 assert.equal((await req('/api/profile',{picture:null,customerId:randomUUID()})).status,400);
 assert.equal((await req('/api/profile',undefined,a.token,'https://relay.example','DELETE')).status,405);
 let oversized;try{oversized=await req('/api/profile',{picture:'a'.repeat(131073)});assert.equal(oversized.status,413);}catch(e){assert.equal(e.code,'ECONNRESET');}
 const saved=await req('/api/profile',{picture:data(png({metadata:true}))});assert.equal(saved.status,200);assert.equal(saved.headers['set-cookie'],undefined);assert.equal(saved.headers['cache-control'],'no-store');const read=await req('/api/profile?customerId='+randomUUID());assert.equal(read.data.picture,saved.data.picture);
 const health=await req('/healthz');assert.equal(health.data.paymentsDisabled,true);assert.equal(calls,0);assert.ok(await accounts.session(a.token));
 await accounts.logout(a.token);assert.equal((await req('/api/profile',{picture:null})).status,401);
 assert.equal((await createProfilePictures(f.store).read(a.account.id)).picture,saved.data.picture);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
