export const initialCalculatorState=()=>({phase:'idle',generation:0,rows:[],selected:null,message:'',checkedAt:null});
export function calculatorReducer(state,event){
 switch(event.type){
 case 'edit':return {...initialCalculatorState(),generation:state.generation+1};
 case 'search':return {...state,phase:'loading',generation:state.generation+1,message:''};
 case 'result':{
  if(event.generation!==state.generation)return state;
  const match=state.selected&&event.rows.find(r=>r.method===state.selected.method)?.offers?.find(o=>o.id===state.selected.offer.id);
  return {...state,phase:'ready',rows:event.rows,checkedAt:event.checkedAt,selected:match?{...state.selected,offer:match}:null,message:state.selected?(match?'The quoted terms still match. This does not reserve an offer.':'The offer changed or is no longer available. Review the latest results.'):''};
 }
 case 'failure':return event.generation===state.generation?{...state,phase:'error',rows:[],selected:null,message:event.message}:state;
 case 'select':{const row=state.rows.find(r=>r.method===event.method),offer=row?.offers?.find(o=>o.id===event.id);return state.phase==='ready'&&offer&&offer.validUntil>event.now?{...state,selected:{method:event.method,offer},message:''}:state;}
 case 'back':return {...state,selected:null,message:''};
 case 'expire':return state.phase==='ready'&&state.rows.some(r=>r.offers?.length)&&state.rows.every(r=>r.offers.every(o=>o.validUntil<=event.now))?{...state,phase:'expired',selected:null,message:'These prices need a refresh. Check again for a current estimate.'}:state;
 default:return state;
 }
}
export function calculatorMessage(row){
 if(row.status==='no_quotes')return 'No offer for this target right now.';
 if(row.status==='evidence_incomplete')return 'The returned figures could not be reconciled. No estimate is shown.';
 if(row.reason==='provider_authentication_required')return 'Provider access is required for this quote.';
 if(row.reason==='quote_rate_limited')return 'Peer is busy. Please try again shortly.';
 return 'Prices could not be checked. Try again shortly.';
}
export const compactAmount=value=>String(value).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
