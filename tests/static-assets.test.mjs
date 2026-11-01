import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHostedServer} from '../hosted/server.mjs';

test('public static assets serve local images and fonts with exact MIME types without account or provider access',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'eupova-assets-'));await mkdir(path.join(root,'assets'));
 const files={'art.webp':'image/webp','body.ttf':'font/ttf','display.woff2':'font/woff2','mark.png':'image/png','app.js':'text/javascript'};
 for(const name of Object.keys(files))await writeFile(path.join(root,'assets',name),'fixture-'+name);
 await writeFile(path.join(root,'secret.env'),'not-public');
 const store=new Proxy({},{get:()=>()=>{throw Error('Static request must not use the database');}});
 const server=createHostedServer({store,config:{origin:'https://static.example',host:'static.example',testers:[]},staticRoot:root,customerAccountsEnabled:false,allowHttpForTests:true,pay:{}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(url,method='GET')=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:url,method,headers:{host:'static.example'}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end();});
 try{
  for(const [name,mime] of Object.entries(files)){const r=await request('/assets/'+name);assert.equal(r.status,200,name);assert.equal(r.headers['content-type'],mime);assert.equal(r.headers['x-content-type-options'],'nosniff');assert.equal(r.body,'fixture-'+name);}
  for(const url of ['/secret.env','/assets/../secret.env','/assets/%2e%2e%2fsecret.env','/assets/file.env','/assets/missing.webp'])assert.equal((await request(url)).status,404,url);
  assert.equal((await request('/assets/art.webp','POST')).status,404);
 }finally{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
