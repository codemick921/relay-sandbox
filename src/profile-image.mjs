export async function prepareProfileImage(file){
 if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('Choose a JPG, PNG or WebP image.');
 if(file.size>5*1024*1024)throw Error('Choose an image smaller than 5 MB.');
 const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('This image could not be opened. Try another file.'));r.readAsDataURL(file);});
 const image=new Image();image.src=data;
 try{await image.decode();}catch{throw Error('This image could not be opened. Try another file.');}
 if(!image.naturalWidth||!image.naturalHeight||image.naturalWidth>8192||image.naturalHeight>8192)throw Error('Choose an image no larger than 8192 pixels on either side.');
 return image;
}
export function cropProfileImage(image,zoom=1){
 const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
 const ctx=canvas.getContext('2d');if(!ctx)throw Error('Image editing is unavailable in this browser.');
 const side=Math.min(image.naturalWidth,image.naturalHeight)/zoom;
 ctx.fillStyle='#edf4ef';ctx.fillRect(0,0,128,128);
 ctx.drawImage(image,(image.naturalWidth-side)/2,(image.naturalHeight-side)/2,side,side,0,0,128,128);
 return canvas.toDataURL('image/png');
}
export function profileInitials(name){return String(name??'').trim().split(/\s+/u).filter(Boolean).slice(0,2).map(x=>Array.from(x)[0]).join('').toLocaleUpperCase()||'E';}
