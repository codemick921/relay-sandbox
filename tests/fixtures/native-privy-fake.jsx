import React,{createContext,useContext,useState} from 'react';
const Context=createContext(null);
export function PrivyProvider({config,children}){const [authenticated,set]=useState(false);window.__sample.config=config;return <Context.Provider value={{ready:true,authenticated,user:authenticated?{id:'did:privy:sample'}:null,getAccessToken:async()=>'sample-token',logout:async()=>{if(window.__sample.scenario!=='sticky')set(false);},set}}>{children}</Context.Provider>;}
export const usePrivy=()=>useContext(Context);
export function useLoginWithEmail(){const c=useContext(Context);return {sendCode:async()=>{window.__sample.codes++;},loginWithCode:async()=>c.set(true)};}
export function useLoginWithPasskey(){const c=useContext(Context);return {loginWithPasskey:async()=>c.set(true)};}
