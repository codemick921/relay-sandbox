import React from 'react';
import {Notice} from './ui';
import {trackingState,trackingMessages,paymentAttemptState,attemptMessage} from '../shared/tracking-status.mjs';
export default function TrackingNotice({order,tracking,expiry,hideReview=false}){
 const t=tracking??trackingState(order),expired=expiry??paymentAttemptState(order);
 if(!t&&!expired)return null;
 return <>{expired&&<Notice>{attemptMessage(expired)}</Notice>}{t&&!(hideReview&&t.code==='review')&&trackingMessages[t.code]&&<Notice error={t.code==='review'}><strong>Tracking update</strong><p>{trackingMessages[t.code]}</p><p className="fine-print">Last successful check: {t.checkedAt?new Date(t.checkedAt).toLocaleString('en-GB'):'not yet recorded'}.</p></Notice>}</>;
}
