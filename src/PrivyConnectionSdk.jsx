import React,{useCallback,useEffect,useRef,useState} from 'react';
import {PrivyProvider,usePrivy,useSubscribeToJwtAuthWithFlag} from '@privy-io/react-auth';
import {createConnectionSession,PRIVY_APP_ID} from './privy-connection-client.mjs';
const config={embeddedWallets:{ethereum:{createOnLogin:'off'},solana:{createOnLogin:'off'},disableAutomaticMigration:true},externalWallets:{disableAllExternalWallets:true,walletConnect:{enabled:false}},appearance:{theme:'light',accentColor:'#254f3b'}};
const descriptions={preparing:'Preparing the connection…',connecting:'Checking your Eupova sign-in with Privy…',connected:'Privy accepted your sign-in. The approved identity matches and no wallet is linked.',disconnecting:'Ending the Privy connection…',disconnected:'Disconnected. Start a fresh test when you are ready.',expired:'Your session or test access could not be confirmed. Return to Eupova to check your sign-in and test access.',error:'The connection could not be completed. No payment was started.',rejected:'The returned identity could not be verified for this test. The connection has been stopped.',cleanup_failed:'Disconnect could not be confirmed. Retry while you are online.'};
function Session({initial}){
 const {ready,authenticated,user,logout}=usePrivy();const logoutRef=useRef(logout);logoutRef.current=logout;
 const [phase,setPhase]=useState('preparing'),session=useRef(null),started=useRef(false),clean=useRef(false);
 if(!session.current)session.current=createConnectionSession({initial,logout:()=>logoutRef.current(),onChange:setPhase});
 const sync=phase==='connecting'||phase==='connected';
 const getExternalJwt=useCallback(()=>session.current.getExternalJwt(),[]);
 useSubscribeToJwtAuthWithFlag({enabled:sync,isAuthenticated:sync,isLoading:false,getExternalJwt,onError:()=>{void session.current.end('error');}});
 // Always clear restored Privy state before beginning this explicit, consented test.
 useEffect(()=>{if(!ready||started.current)return;started.current=true;let live=true;logoutRef.current().then(()=>{if(live)clean.current=true;}).catch(()=>{if(live)setPhase('cleanup_failed');});return()=>{live=false;};},[ready]);
 useEffect(()=>{
  if(ready&&clean.current&&!authenticated&&phase==='preparing')void session.current.start();
  if(phase!=='preparing'&&phase!=='cleanup_failed')session.current.providerState(authenticated,user);
 },[ready,authenticated,user]);
 // logout may finish without a React auth-state transition when already signed out.
 useEffect(()=>{if(phase!=='preparing')return;const t=setInterval(()=>{if(ready&&clean.current&&!authenticated)void session.current.start();},100);return()=>clearInterval(t);},[phase,ready,authenticated]);
 useEffect(()=>{
  const refresh=()=>void session.current.refresh();const stop=()=>void session.current.end('expired');
  const timer=setInterval(refresh,15000),expiry=setTimeout(stop,Math.max(0,initial.expiresAt-Date.now()));
  const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('eupova-auth-events'):null;if(channel)channel.onmessage=stop;
  window.addEventListener('focus',refresh);window.addEventListener('online',refresh);document.addEventListener('visibilitychange',refresh);window.addEventListener('pagehide',stop);
  return()=>{clearInterval(timer);clearTimeout(expiry);channel?.close();window.removeEventListener('focus',refresh);window.removeEventListener('online',refresh);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('pagehide',stop);void session.current.close();};
 },[initial]);
 useEffect(()=>{if(!['preparing','connecting'].includes(phase))return;const t=setTimeout(()=>void session.current.end('error'),30000);return()=>clearTimeout(t);},[phase]);
 const ended=['disconnected','expired','error','rejected'].includes(phase);
 return <div className="privy-test-status"><span className="buyer-connection-label">{phase==='connected'?'Connected':'Development test'}</span><h2 aria-live="polite">{phase==='connected'?'Your connection is ready.':ended?'Test ended.':'Your Privy connection'}</h2><p role="status">{descriptions[phase]}</p>
 {ended?<a className="btn" href="/">Back to Eupova</a>:<button className="btn" disabled={phase==='disconnecting'} onClick={()=>void session.current.end('disconnected')}>{phase==='cleanup_failed'?'Retry disconnect':phase==='connected'?'Disconnect':'Cancel connection'}</button>}
 <p className="buyer-connection-footnote">This test checks sign-in only. Wallet creation, signing, payments and checkout are unavailable here.</p></div>;
}
export default function PrivyConnectionSdk({initial}){return <PrivyProvider appId={PRIVY_APP_ID} config={config}><Session initial={initial}/></PrivyProvider>;}
