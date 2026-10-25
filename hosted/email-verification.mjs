// Public, account-owned projection only. No token, address, message body or provider ID.
export function emailVerificationState({verifiedAt,mailEnabled=false,mailPreview=false,job,now=Date.now()}){
 const mode=mailPreview?'preview':mailEnabled?'email':'unavailable';
 let status=verifiedAt?'verified':!mailEnabled?'unavailable':'not_requested';
 if(!verifiedAt&&mailEnabled&&job){
  if(job.consumed_at||job.state==='suppressed')status='superseded';
  else if(job.expires_at&&new Date(job.expires_at).getTime()<=now)status='expired';
  else if(job.state==='queued'&&now-new Date(job.created_at).getTime()>=3600000)status='expired';
  else if(job.state==='sending'&&(!job.attempted_at||now-new Date(job.attempted_at).getTime()>=60000))status='unknown';
  else status=['queued','sending','accepted','unknown'].includes(job.state)?job.state:'unknown';
 }
 return {mode,status,verified:!!verifiedAt,verifiedAt:verifiedAt??null,requestedAt:job?.created_at??null,expiresAt:job?.expires_at??null};
}
