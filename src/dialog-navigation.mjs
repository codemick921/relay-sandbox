// Session-only navigation. No API calls or browser-history payment actions.
export const emptyDialogs = () => ({entries:[],index:-1});
export const currentDialog = navigation => navigation.entries[navigation.index] ?? null;
const sameTarget = (a,b) => a?.kind===b?.kind && a?.id===b?.id && JSON.stringify(a?.preset)===JSON.stringify(b?.preset);
export function dialogNavigation(navigation,action){
 if(action.type==='close')return emptyDialogs();
 if(action.type==='reset')return action.entry?{entries:[action.entry],index:0}:emptyDialogs();
 if(action.type==='back')return navigation.index>0?{...navigation,index:navigation.index-1}:emptyDialogs();
 if(action.type==='open'){
  if(sameTarget(currentDialog(navigation),action.entry))return navigation;
  if(sameTarget(navigation.entries[navigation.index+1],action.entry))return {...navigation,index:navigation.index+1};
  return {entries:[...navigation.entries.slice(0,navigation.index+1),action.entry],index:navigation.index+1};
 }
 return navigation;
}
export function dialogPath(dialog,pathname){
 if(dialog?.kind==='order')return pathname+'?checkout='+encodeURIComponent(dialog.id);
 if(dialog?.kind==='funding-draft')return pathname+'#funding='+encodeURIComponent(dialog.id);
 return pathname;
}
