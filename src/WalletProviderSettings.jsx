import React from 'react';

// Test settings: how the wallet could be provided. Comparison only; it creates nothing and requests nothing.
export function WalletProviderSettings({cw}){
 return <details className="panel cw-section cw-settings">
  <summary>Test settings: wallet providers</summary>
  <p className="cw-lede">The same wallet screen sits on different providers. Only the simulated one is in use here. A live wallet exists only on a deployment whose settings are complete and consistent, and the list below shows what each one needs.</p>
  <ul className="cw-providers">{cw.providers.map(p=><li key={p.id} className="cw-provider">
   <header><h3>{p.label}</h3><span className={'cw-pill '+(p.active?'cw-pill--ok':'')}>{p.active?'In use':p.ready?'Settings complete':'Not available'}</span></header>
   <p className="cw-note">{p.summary}</p>
   {p.missing.length>0&&<><strong className="cw-missing-title">Needed before it can open</strong><ul className="cw-missing">{p.missing.map((m,i)=><li key={i}>{m.what}{m.env&&<> <code>{m.env}</code></>}</li>)}</ul></>}
  </li>)}</ul>
 </details>;
}
