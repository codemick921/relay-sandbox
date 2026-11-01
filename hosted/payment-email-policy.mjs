import {createHash} from 'node:crypto';
import {paymentRecord} from './payment-records.mjs';

// Pure planning only. Not registered with a worker, transport or database.
export const PAYMENT_EMAIL_SENDING_ENABLED=false;
export const defaultPaymentEmailPreferences=()=>({arrival:false,attention:false,arrivalSince:null,attentionSince:null});
const attentionCodes=new Set(['review','disputed','uncertain','partial']);
const iso=ms=>new Date(ms).toISOString();
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function updatePaymentEmailPreferences(previous,input,now=Date.now()){
 if(!input||Object.keys(input).length!==2||['arrival','attention'].some(k=>typeof input[k]!=='boolean'))throw Error('Choose both email preferences.');
 const next={...previous};
 for(const kind of ['arrival','attention']){next[kind]=input[kind];next[kind+'Since']=input[kind]?(previous[kind]?previous[kind+'Since']:iso(now)):null;}
 return next;
}
export function planPaymentEmail({order,owner,account,preferences=defaultPaymentEmailPreferences(),previous=null,now=Date.now()}){
 if(!account?.id||owner!==`customer:${account.id}`||order?.owner!==owner)return {decision:'wrong_account',snapshot:previous,event:null};
 const record=paymentRecord(order,null,now);
 const kind=attentionCodes.has(record.code)?'attention':record.deliveryConfirmed?'arrival':null;
 const fingerprint=digest(kind==='arrival'?['arrival',record.receipts.map(r=>[r.transactionHash.toLowerCase(),r.amountUsdc]).sort()]:[kind,record.code]);
 const snapshot={owner,requestId:record.id,kind,fingerprint,observedAt:iso(now),arrived:(previous?.owner===owner&&previous?.requestId===record.id&&previous?.arrived===true)||record.deliveryConfirmed};
 const result=decision=>({decision,snapshot,event:null});
 if(record.simulated)return result('simulation');
 // Seed a baseline rather than emailing historical payments when the feature starts.
 if(!previous||previous.owner!==owner||previous.requestId!==record.id)return result('baseline');
 if(!kind)return result('no_update');
 if(previous.fingerprint===fingerprint)return result('duplicate');
 if(kind==='arrival'&&previous.arrived)return result('arrival_already_recorded');
 if(!account.emailVerified||account.disabled||typeof account.email!=='string'||!/^\S+@\S+\.\S+$/.test(account.email))return result('account_unavailable');
 if(!preferences[kind])return result('opted_out');
 const since=Date.parse(preferences[kind+'Since']);
 // Preferences apply only to transitions observed after opt-in, never a backlog.
 if(!Number.isFinite(since)||!Number.isFinite(Date.parse(previous.observedAt))||since>Date.parse(previous.observedAt))return result('before_opt_in');
 if(record.trackingUnavailable||record.stale||!record.checkedAt||Date.parse(record.checkedAt)>now+60000)return {...result('evidence_unavailable'),snapshot:previous};
 return {decision:'preview_ready',snapshot,event:{key:digest([owner,record.id,kind,fingerprint]),owner,requestId:record.id,kind,code:record.code,amountUsdc:kind==='arrival'?record.confirmedUsdc:null,walletName:record.agentName,observedAt:iso(now)}};
}
