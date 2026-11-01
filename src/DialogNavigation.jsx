import React,{createContext,useContext,useRef,useState} from 'react';
import {currentDialog,dialogNavigation,dialogPath,emptyDialogs} from './dialog-navigation.mjs';
export const DialogNavigation = createContext(null);
export function useDialogNavigation({busy,onNavigate,page}){
 const [navigation,setNavigation]=useState(emptyDialogs);
 const current=useRef(navigation);current.current=navigation;
 const entry=(target)=>target?{...target,key:crypto.randomUUID(),values:{}}:null;
 const change=action=>{
  if(busy)return;
  const next=dialogNavigation(current.current,action);current.current=next;setNavigation(next);onNavigate();
  history.replaceState(null,'',dialogPath(currentDialog(next),location.pathname));
 };
 const reset=target=>change({type:'reset',entry:entry(target)});
 const open=(kind,id,preset)=>change({type:'open',entry:entry({kind,id,preset})});
 const close=()=>change({type:'close'}),back=()=>change({type:'back'});
 const modal=currentDialog(navigation);
 return {modal,reset,open,close,context:{back,busy,values:modal?.values,backLabel:navigation.index>0?'Back to previous screen':`Back to ${page==='My agents'?'your wallets':page.toLowerCase()}`}};
}
// Retain only explicitly opted-in, non-secret funding fields until the dialog closes.
// Passwords, payment consent, quotes and verification results must never use this hook.
export function useDialogState(name,initial){
 const context=useContext(DialogNavigation),values=context?.values;
 const [value,setValue]=useState(()=>values&&Object.hasOwn(values,name)?values[name]:typeof initial==='function'?initial():initial);
 if(values&&!Object.hasOwn(values,name))values[name]=value;
 const update=next=>setValue(previous=>{const result=typeof next==='function'?next(previous):next;if(values)values[name]=result;return result;});
 return [value,update];
}
