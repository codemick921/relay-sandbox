import React from 'react';
import {fundingCompatibility,fundingAssets} from '../shared/funding-compatibility.mjs';
import './funding-compatibility.css';
export {fundingAssets};
export default function FundingCompatibility(props){
 const result=fundingCompatibility(props);
 const checks=result.checks.filter(check=>check.id!=='policy'&&(!props.requestSummary||!['verification','spending'].includes(check.id)));
 return <section className="funding-compatibility" aria-label="Funding compatibility check">
  <h3>Check the route to your agent</h3><p className="compatibility-summary" role="status">{result.title}</p>
  <ul>{checks.map(check=><li key={check.id} data-status={check.status}><span className="compatibility-badge">{check.status==='pass'?'Matches':check.status==='blocked'?'Needs attention':'Not checked'}</span><div><strong>{check.label}</strong><p>{check.detail}</p></div></li>)}</ul>
  {result.target&&<details><summary>Exact receiving asset</summary><p>{result.target.label} · chain {result.target.chainId}</p><code>{result.target.contract}</code></details>}
  <p className="fine-print">This check uses saved details. It does not contact a provider, verify a live offer or enable payments.</p>
 </section>;
}
