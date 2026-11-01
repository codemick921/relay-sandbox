import React from 'react';
import {Icon} from './ui';
import ribbon from './assets/funding-ribbon.webp';
import ribbonSmall from './assets/funding-ribbon-small.webp';

export function AccessRibbon({className=''}){
 return <img className={className} src={ribbon} srcSet={`${ribbonSmall} 600w, ${ribbon} 1200w`} sizes="(max-width: 900px) 140px, 580px" width="1200" height="800" alt="" decoding="async"/>;
}
export default function AccessArtwork(){
 return <aside className="auth-art" aria-label="About Eupova">
  <div className="auth-art-copy"><h2>A home for your<br/>agent wallets.</h2><p>Save your destinations and keep track of your funding.</p></div>
  <AccessRibbon className="auth-art-ribbon"/>
  <div className="auth-art-features"><span><Icon name="wallet" size={20}/>Saved wallets</span><span><Icon name="activity" size={20}/>Funding history</span></div>
 </aside>;
}
