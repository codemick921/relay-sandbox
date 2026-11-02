// Isolated browser fixture: controllable SDK ordering, never imports/calls Privy.
import React,{createContext,useContext,useEffect,useState,useRef} from 'react';
const C=createContext(null);
export function PrivyProvider({config,children}){
 const [state,setState]=useState({authenticated:false,user:null});window.__sample.config=config;
 const api={...state,ready:true,logout:async()=>{
  window.__sample.logouts++;
  if(window.__sample.scenario==='sticky_logout'&&window.__sample.logouts>1)return;
  setState({authenticated:false,user:null});
 },getAccessToken:async()=>window.__sample.scenario==='missing_access'?null:'sample.access.token',setState};
 return <C.Provider value={api}>{children}</C.Provider>;
}
export function usePrivy(){return useContext(C);}
export function useSubscribeToJwtAuthWithFlag({enabled,isAuthenticated,getExternalJwt,onAuthenticated,onError}){
 const api=useContext(C),ref=useRef({api,onAuthenticated,onError});ref.current={api,onAuthenticated,onError};
 useEffect(()=>{
  if(!enabled||!isAuthenticated)return;
  getExternalJwt().then(token=>{
   if(!token)return;
   // An SDK exchange already begun cannot be cancelled just by disabling its hook.
   const scenario=window.__sample.scenario;
   setTimeout(()=>{
    if(scenario==='sdk_error'){ref.current.onError?.(Error('never-display-private-token'));return;}
    ref.current.onAuthenticated?.({user:window.__sample.user});
    setTimeout(()=>ref.current.api.setState({authenticated:true,user:window.__sample.user}),scenario==='callback_delay'?250:0);
   },scenario==='late_auth'?700:10);
  });
 },[enabled,isAuthenticated,getExternalJwt]);
}
