// Browser-test substitute only. No Privy imports or network calls.
import React,{createContext,useContext,useEffect,useState,useRef} from 'react';
const C=createContext(null);
export function PrivyProvider({config,children}){const [state,setState]=useState({authenticated:false,user:null});window.__sample.config=config;const api={...state,ready:true,logout:async()=>{window.__sample.logouts++;setState({authenticated:false,user:null});},getAccessToken:async()=> 'sample.access.token',setState};return <C.Provider value={api}>{children}</C.Provider>;}
export function usePrivy(){return useContext(C);}
export function useSubscribeToJwtAuthWithFlag({enabled,isAuthenticated,getExternalJwt}){const api=useContext(C),ref=useRef(api);ref.current=api;useEffect(()=>{if(!enabled||!isAuthenticated)return;let live=true;getExternalJwt().then(token=>{if(live&&token)ref.current.setState({authenticated:true,user:window.__sample.user});});return()=>{live=false;};},[enabled,isAuthenticated,getExternalJwt]);}
