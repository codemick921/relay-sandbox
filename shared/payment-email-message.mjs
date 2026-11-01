const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function paymentDetailLink(origin,id){
 const url=new URL(origin);
 if(!uuid.test(id)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&url.hostname==='127.0.0.1')))throw Error('Invalid payment email link.');
 return `${url.origin}/#payment=${id}`;
}
export function paymentEmailMessage(event,{origin='https://app.eupova.com',sample=false}={}){
 if(!['arrival','attention'].includes(event?.kind))throw Error('Invalid payment email event.');
 if(event.kind==='arrival'&&(!/^\d{1,18}\.\d{6}$/.test(event.amountUsdc??'')||!/[1-9]/.test(event.amountUsdc)))throw Error('A verified USDC amount is required.');
 const link=paymentDetailLink(origin,event.requestId),wallet=String(event.walletName??'Your wallet').replace(/[\r\n]/g,' ').slice(0,60);
 const arrival=event.kind==='arrival';
 const subject=arrival?'Your wallet funding has arrived':'Your funding request needs attention';
 const heading=arrival?'Funds arrived':'Check your funding request';
 const amount=arrival?event.amountUsdc.replace(/0+$/,'').replace(/\.$/,'')+' USDC':null;
 const summary=arrival?`Eupova has confirmed ${amount} delivered to ${wallet} on Base.`:({partial:'Part of this payment is recorded. Open the request to check the amount still outstanding.',disputed:'A dispute is recorded for this payment. Open the request for its current status.',uncertain:'The checkout status needs checking. Open your existing request to review it.',review:'The payment details need review. Open the request to see what has been confirmed.'}[event.code]??'Open your existing request to review its current status.');
 const note=arrival?'This confirms the recorded transfer, not your wallet’s current balance.':'If you have already paid, do not send the payment again. Keep your bank confirmation.';
 const footer='You chose optional payment emails. Manage these updates in Eupova under Notifications → Email updates.';
 const text=[sample?'SAMPLE EMAIL: Not sent':'',heading,summary,note,'View payment: '+link,'Request: '+event.requestId,footer].filter(Boolean).join('\n\n');
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(subject)}</title></head><body style="margin:0;background:#edf5ef;color:#214f3c;font-family:Arial,sans-serif;line-height:1.6"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 12px"><table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #d7e3da;border-radius:20px"><tr><td style="padding:28px"><p style="font-size:24px;font-weight:700;margin:0 0 24px">Eupova</p>${sample?'<p style="font-size:13px;color:#52685b">Sample email. Not sent.</p>':''}<h1 style="font-size:28px;line-height:1.2;margin:0 0 20px">${heading}</h1>${arrival?`<p style="background:#f4effb;border-radius:12px;padding:18px;font-size:30px;font-weight:700;margin:0 0 20px">${escape(amount)}</p>`:''}<p>${escape(summary)}</p><p style="color:#52685b">${escape(note)}</p><p style="margin:26px 0"><${sample?'span':'a'} ${sample?'':`href="${escape(link)}"`} style="display:inline-block;background:#214f3c;color:#fff;text-decoration:none;border-radius:9px;padding:13px 22px;font-weight:700">View payment</${sample?'span':'a'}></p><p style="font-size:12px;color:#52685b;overflow-wrap:anywhere">Request: ${escape(event.requestId)}</p><p style="font-size:13px;color:#52685b;border-top:1px solid #d7e3da;padding-top:18px">${escape(footer)}</p></td></tr></table></td></tr></table></body></html>`;
 return {subject,text,html,link,heading,summary,note,amount};
}
