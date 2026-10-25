import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,copyFile,rm} from 'node:fs/promises';
import {createHostedServer} from '../hosted/server.mjs';

test('hosted logo is served as a PNG while non-asset paths and unknown types stay blocked',async()=>{
 const root=await mkdtemp(fileURLToPath(new URL('../.brand-assets-',import.meta.url)));let server;
 try{
  await mkdir(root+'/assets');await copyFile(new URL('../src/assets/eupova-mark.png',import.meta.url),root+'/assets/eupova-test.png');
  server=createHostedServer({store:{},config:{origin:'https://sandbox.example',host:'sandbox.example',testers:[]},staticRoot:root,allowHttpForTests:true,paymentsDisabled:true,customerAccountsEnabled:false});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const get=path=>new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port:server.address().port,path,headers:{host:'sandbox.example'}},r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,type:r.headers['content-type'],data:Buffer.concat(chunks)}));});req.on('error',reject);});
  const image=await get('/assets/eupova-test.png');assert.equal(image.status,200);assert.equal(image.type,'image/png');assert.equal(image.data.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  for(const path of ['/src/assets/eupova-mark.png','/assets/eupova-test.txt','/assets/../secret.png','/assets/%2e%2e%2fsecret.png'])assert.equal((await get(path)).status,404,path);
 }finally{if(server)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
