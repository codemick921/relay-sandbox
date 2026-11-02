// Overview projection of saved customer evidence. No provider calls or state changes.
export function overviewGroup(record){
 if(record.simulated||record.source==='simulated')return null;
 if(['review','uncertain','partial','disputed','attempt_expired'].includes(record.code))return 'attention';
 if(record.code==='received')return record.deliveryConfirmed===true?null:'attention';
 if(record.code==='ended')return null;
 return 'progress';
}
const fields=['id','agentName','requestedAmount','requestedGbp','currency','code','title','next','createdAt','checkedAt','stale','trackingUnavailable','providerFulfilled','deliveryConfirmed'];
export function createOverview(){return {total:0,attention:{total:0,records:[]},progress:{total:0,records:[]}};}
// Feed newest-first projected records, after owner/source filtering and draft merging.
export function addOverviewRecord(overview,record){
 if(record.simulated||record.source==='simulated')return;
 overview.total++;
 const key=overviewGroup(record);if(!key)return;
 const group=overview[key];group.total++;
 if(group.records.length<3)group.records.push(Object.fromEntries(fields.map(k=>[k,record[k]??null])));
}
