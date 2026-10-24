import React,{useEffect,useState} from 'react';
import {Button,Field,Notice} from './ui';
import {resumeLink} from './payment-resume.mjs';

export default function PhoneResume({id,trackingOnly=false}){
 const [expanded,setExpanded]=useState(false),[code,setCode]=useState(null),[message,setMessage]=useState(''),[qrFailed,setQrFailed]=useState(false);
 const link=resumeLink(window.location.origin,id),local=window.location.hostname==='127.0.0.1';
 useEffect(()=>{
  let active=true;setCode(null);setMessage('');setQrFailed(false);
  if(expanded)import('qrcode').then(module=>{
   const qr=(module.default??module).create(link,{errorCorrectionLevel:'M'}),size=qr.modules.size;
   // Four-module quiet zone; SVG pixels are generated here, never by a remote QR service.
   const path=[];for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(qr.modules.get(y,x))path.push(`M${x+4},${y+4}h1v1h-1z`);
   if(active)setCode({size:size+8,path:path.join('')});
  }).catch(()=>{if(active){setQrFailed(true);setMessage('QR code unavailable. Copy the Relay link instead.');}});
  return()=>{active=false;};
 },[expanded,link]);
 return <section className="phone-resume" aria-label="Continue on your phone">
  <Button secondary className="full" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{trackingOnly?'Track this request on your phone':'Continue on your phone'}</Button>
  {expanded&&<div className="phone-resume-content">
   <h3>{trackingOnly?'Follow the same request':'Pick up the same funding request'}</h3>
   <p>Scan with your phone’s Camera app to open Relay, then sign in to the same customer account. Scanning does not send money or create another order.</p>
   {local&&<Notice>Local preview only. This link works on this Mac; phone access will work from Relay’s hosted HTTPS address.</Notice>}
   {code?<svg className="resume-qr" viewBox={`0 0 ${code.size} ${code.size}`} role="img" aria-label="QR code to open this request in Relay" shapeRendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d={code.path} fill="black"/></svg>:!qrFailed&&<p>Preparing QR code…</p>}
   <Field label="Relay resume link"><input readOnly value={link} onFocus={e=>e.target.select()}/></Field>
   <Button secondary onClick={async()=>{try{await navigator.clipboard.writeText(link);setMessage('Relay link copied. Open it on your phone and sign in.');}catch{setMessage('Copy is unavailable here. Select and copy the link above.');}}}>Copy Relay link</Button>
   <p role="status">{message}</p>
   <p className="fine-print">This opens Relay, not your bank app. {trackingOnly?'Tracking remains available for this request.':'Open the saved checkout from Relay to get current payment and verification instructions.'} If you have already paid, do not send the money again.</p>
  </div>}
 </section>;
}
