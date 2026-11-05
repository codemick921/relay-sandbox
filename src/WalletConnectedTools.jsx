import React,{useState} from 'react';
import {Button,Notice,Field,Check} from './ui';
import {trimUsdc,whenText,HOUR_CHOICES} from './wallet-view.mjs';

function Pairing({act,busy}){
 const [code,setCode]=useState('');
 return <form className="cw-pair" onSubmit={async e=>{e.preventDefault();if(await act('wallet/tools/approve-enrolment',{userCode:code}))setCode('');}}>
  <Field label="Connect a tool" hint="Run the tool's enrol command, then type the code it shows. It gets no allowance until you give one."><input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="ABCD-2345" maxLength={9} autoComplete="off" spellCheck="false"/></Field>
  <Button disabled={busy||code.replace(/[^A-Z0-9]/g,'').length!==8}>Connect tool</Button>
 </form>;
}

function Allowance({tool,cw,act,busy}){
 const a=tool.allowance,editing=!!a?.active;
 const [amount,setAmount]=useState(editing?String(Number(a.amountUsdc)):'10'),[hours,setHours]=useState(24),[sure,setSure]=useState(false);
 const set=()=>act('wallet/tools/allowance',{toolId:tool.id,amount,hours,confirm:true,confirmation:cw.allowanceConfirmation,...(editing?{expectedRevision:a.revision}:{})});
 return <div className="cw-allowance">
  {editing?<p className="cw-note">Allowance: <strong>{trimUsdc(a.remainingUsdc)}</strong> of {trimUsdc(a.amountUsdc)} USDC left until {whenText(a.expiresAt)}. Every payment still needs your approval.</p>
   :<p className="cw-note">No allowance. This tool cannot be paid anything until you give it one{a?' (the last one has ended)':''}.</p>}
  <div className="cw-allow-form">
   <Field label="Allowance (USDC)"><input value={amount} onChange={e=>setAmount(e.target.value)} inputMode="decimal"/></Field>
   <Field label="For"><select value={hours} onChange={e=>setHours(Number(e.target.value))}>{HOUR_CHOICES.map(([h,l])=><option key={h} value={h}>{l}</option>)}</select></Field>
  </div>
  <Check checked={sure} onChange={e=>setSure(e.target.checked)}>{cw.allowanceConfirmation}</Check>
  <div className="cw-actions"><Button type="button" disabled={busy||!sure||!/^\d{1,3}(\.\d{1,6})?$/.test(amount)} onClick={async()=>{if(await set())setSure(false);}}>{editing?'Change allowance':'Give allowance'}</Button>
   {editing&&<Button type="button" secondary disabled={busy} onClick={()=>act('wallet/tools/allowance/revoke',{toolId:tool.id})}>End allowance</Button>}</div>
 </div>;
}

export function WalletConnectedTools({cw,act,busy}){
 const tools=cw.tools.filter(t=>t.status==='active'),ended=cw.tools.filter(t=>t.status!=='active');
 return <section className="panel cw-section" aria-labelledby="cw-tools-title">
  <h2 id="cw-tools-title">Connected tools</h2>
  <p className="cw-lede">A connected tool, such as a command-line client, can <em>ask</em> your wallet to pay. It needs two things from you every time: an allowance you chose, and your approval of each payment. It can never approve for itself.</p>
  {tools.length===0&&<p className="cw-empty">No tools are connected.</p>}
  <ul className="cw-tools">{tools.map(t=><li key={t.id} className="cw-tool">
   <header><h3>{t.name}</h3><span className="cw-pill">{t.credentialCollected?(t.lastSeenAt?`Last used ${whenText(t.lastSeenAt)}`:'Connected'):'Waiting to finish connecting'}</span></header>
   <Allowance tool={t} cw={cw} act={act} busy={busy}/>
   <div className="cw-actions"><Button type="button" secondary disabled={busy} onClick={()=>{if(window.confirm(`Disconnect ${t.name}? Its credential stops working straight away and waiting requests are cancelled.`))act('wallet/tools/revoke',{toolId:t.id});}}>Disconnect tool</Button></div>
  </li>)}</ul>
  <Pairing act={act} busy={busy}/>
  {ended.length>0&&<details className="cw-recent"><summary>Disconnected tools ({ended.length})</summary><ul className="cw-recent-list">{ended.map(t=><li key={t.id}><div><strong>{t.name}</strong><small>Disconnected {whenText(t.revokedAt)}</small></div></li>)}</ul></details>}
  <details className="cw-recent"><summary>How a tool connects</summary><ol className="cw-steps"><li>In a terminal: <code>node scripts/eupova-tool-cli.mjs enrol --url YOUR_PREVIEW_URL --name "My CLI"</code></li><li>Enter the code it prints above.</li><li>Run <code>enrol-wait</code>, then give the tool an allowance here.</li><li>The tool runs <code>pay</code>. The request appears under Pending approvals.</li></ol></details>
 </section>;
}
