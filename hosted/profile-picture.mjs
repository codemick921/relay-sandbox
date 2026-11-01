import {inflateSync,deflateSync} from 'node:zlib';
import {InputError} from '../server/validation.mjs';
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);name.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([name,data])),out.length-4);return out;}
// Accept a bounded browser-rendered PNG, validate its pixels, and rebuild without
// metadata, animation chunks or trailing payload. No image URL is ever fetched.
export function normaliseProfilePicture(value){
 if(value===null)return null;
 const invalid=()=>new InputError('Choose a JPG, PNG or WebP image and try saving it again.');
 if(typeof value!=='string'||value.length>110000||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))throw invalid();
 const encoded=value.slice(22),bytes=Buffer.from(encoded,'base64');
 if(bytes.toString('base64')!==encoded||bytes.length>80000||!bytes.subarray(0,8).equals(signature))throw invalid();
 let offset=8,header=null,ended=false,seenData=false,dataEnded=false;const parts=[];
 while(offset<bytes.length){
  if(offset+12>bytes.length)throw invalid();
  const length=bytes.readUInt32BE(offset),end=offset+12+length;
  if(end>bytes.length)throw invalid();
  const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,end-4);
  if(!/^[A-Za-z]{4}$/.test(type)||crc(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))throw invalid();
  if(!header&&type!=='IHDR')throw invalid();
  if(type==='IHDR'){
   if(header||length!==13||data.readUInt32BE(0)!==128||data.readUInt32BE(4)!==128||data[8]!==8||![2,6].includes(data[9])||data[10]||data[11]||data[12])throw invalid();
   header=Buffer.from(data);
  }else if(type==='IDAT'){if(dataEnded)throw invalid();seenData=true;parts.push(data);}
  else if(type==='IEND'){if(length||!seenData||end!==bytes.length)throw invalid();ended=true;offset=end;break;}
  else{if(seenData)dataEnded=true;if(type[0]===type[0].toUpperCase()||['acTL','fcTL','fdAT'].includes(type))throw invalid();}
  offset=end;
 }
 if(!ended||!header)throw invalid();
 const stride=128*(header[9]===6?4:3)+1,expected=stride*128;let pixels;
 try{pixels=inflateSync(Buffer.concat(parts),{maxOutputLength:expected});}catch{throw invalid();}
 if(pixels.length!==expected)throw invalid();
 for(let i=0;i<128;i++)if(pixels[i*stride]>4)throw invalid();
 const safe=Buffer.concat([signature,chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
 return 'data:image/png;base64,'+safe.toString('base64');
}
export function createProfilePictures(store){
 return {
  async read(customerId){const row=(await store.query('SELECT picture FROM relay_customer_profiles WHERE customer_id=$1',[customerId])).rows[0];return {picture:row?.picture??null};},
  async save(customerId,input){
   if(!input||Object.keys(input).length!==1||!Object.hasOwn(input,'picture'))throw new InputError('Invalid profile picture request.');
   const picture=normaliseProfilePicture(input.picture);
   await store.query('INSERT INTO relay_customer_profiles(customer_id,picture) VALUES($1,$2) ON CONFLICT(customer_id) DO UPDATE SET picture=EXCLUDED.picture,updated_at=now()',[customerId,picture]);
   return {picture};
  }
 };
}
