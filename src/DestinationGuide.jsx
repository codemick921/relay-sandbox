import React,{useId,useState} from 'react';
import {Icon,Button,Modal} from './ui';
import {destinationProfiles,receivingQuestions,receivingGuidance} from './destination-profiles.mjs';
import './destination-guide.css';

export function DestinationProfiles(){
 const [selected,setSelected]=useState('base'),[answers,setAnswers]=useState({});
 const id=useId(),profile=destinationProfiles.find(p=>p.id===selected),result=receivingGuidance(selected,answers);
 return <div className="receiving-profiles">
  <p className="receiving-intro">Choose where your agent will receive funds. You can use these guides without connecting a wallet.</p>
  <div className="receiving-picker" role="group" aria-label="Receiving destination type">{destinationProfiles.map(p=><button type="button" key={p.id} aria-pressed={selected===p.id} onClick={()=>{setSelected(p.id);setAnswers({});}}><Icon name={p.icon} size={22}/><span><strong>{p.name}</strong><small>{p.description}</small></span></button>)}</div>
  <section className="receiving-instructions" aria-labelledby={id+'-heading'}>
   <div className="receiving-route"><Icon name="info" size={18}/><span>{profile.route}</span></div>
   <h3 id={id+'-heading'}>{profile.title}</h3><p>{profile.intro}</p>
   <ol className="receiving-steps">{profile.steps.map(([title,body])=><li key={title}><strong>{title}</strong><p>{body}</p></li>)}</ol>
   <div className="receiving-sources"><span>{profile.evidence}{profile.checked?' · 2 November 2026':''}</span>{profile.sources.map(s=><a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">{s.label}<span className="sr-only"> (opens in a new tab)</span><Icon name="arrow" size={16}/></a>)}</div>
  </section>
  {selected!=='tempo'&&<details className="receiving-checklist" key={selected}><summary>Check my receiving instructions</summary><div className="receiving-questions">{receivingQuestions.map(q=><label key={q.id} htmlFor={id+'-'+q.id}><span>{q.label}</span><select id={id+'-'+q.id} value={answers[q.id]??''} onChange={e=>setAnswers(a=>({...a,[q.id]:e.target.value}))}><option value="">Not checked yet</option><option value="yes">Yes</option><option value="no">No</option></select></label>)}</div><div className={'receiving-result is-'+result.kind} role="status"><strong>{result.title}</strong><p>{result.detail}</p></div></details>}
  {selected==='tempo'&&<div className="receiving-result is-unsupported" role="status"><strong>{result.title}</strong><p>{result.detail}</p></div>}
  <p className="receiving-footnote">A guide does not verify wallet ownership or account credit. Saving an address gives Eupova no spending access.</p>
 </div>;
}
export function ReceivingGuideEntry(){
 const [open,setOpen]=useState(false);
 return <><section className="receiving-entry"><span className="receiving-entry-icon"><Icon name="wallet" size={26}/></span><div><h2>Find the right receiving address.</h2><p>Instructions for Base wallets and agent wallets inside other platforms.</p></div><Button secondary type="button" onClick={()=>setOpen(true)}>Receiving guides</Button></section>{open&&<Modal title="Receiving guides" className="receiving-modal" wide onClose={()=>setOpen(false)}><DestinationProfiles/></Modal>}</>;
}
export default function DestinationGuide(){return <details className="destination-guide"><summary><Icon name="info" size={18}/>Check your platform’s receiving instructions</summary><DestinationProfiles/></details>;}
