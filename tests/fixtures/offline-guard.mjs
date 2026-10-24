// Fail tests if a default fetch or TCP connection attempts to leave this machine.
import net from 'node:net';
const local=host=>['127.0.0.1','localhost','::1','[::1]'].includes(host);
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(!local(url.hostname))throw Error('Offline test guard blocked an external fetch.');
 return originalFetch(input,options);
};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 // Node normalises connect arguments internally to [options, callback].
 const first=Array.isArray(args[0])?args[0][0]:args[0];
 const options=typeof first==='object'?first:null;
 const host=options?.host??(typeof args[1]==='string'?args[1]:'localhost');
 if(options?.path||typeof first==='string'||!local(host))throw Error('Offline test guard blocked a non-local connection.');
 return connect.apply(this,args);
};
