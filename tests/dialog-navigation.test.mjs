import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDialogs,currentDialog,dialogNavigation as move,dialogPath} from '../src/dialog-navigation.mjs';
const entry=(kind,id,values={})=>({kind,id,values,key:kind+id});
test('back and forward preserve entered details; choosing a different route discards forward navigation',()=>{
 let nav=move(emptyDialogs(),{type:'open',entry:entry('fund')});
 const form=entry('peer-fund','wallet',{amount:'42.50',currency:'EUR'});
 nav=move(nav,{type:'open',entry:form});nav=move(nav,{type:'back'});
 assert.equal(currentDialog(nav).kind,'fund');
 nav=move(nav,{type:'open',entry:entry('peer-fund','wallet')});assert.equal(currentDialog(nav),form);
 nav=move(nav,{type:'back'});nav=move(nav,{type:'open',entry:entry('wallet')});
 assert.equal(currentDialog(nav).kind,'wallet');assert.equal(nav.entries.includes(form),false);
});
test('close and external deep links clear old form memory; root back exits',()=>{
 let nav=move(emptyDialogs(),{type:'open',entry:entry('peer-fund','wallet',{amount:'42'})});
 nav=move(nav,{type:'reset',entry:entry('funding-draft','saved')});assert.equal(nav.entries.length,1);assert.deepEqual(currentDialog(nav).values,{});
 assert.deepEqual(move(nav,{type:'back'}),emptyDialogs());assert.deepEqual(move(nav,{type:'close'}),emptyDialogs());
});
test('review navigation changes only the visible location, never the saved request',()=>{
 const draft=entry('funding-draft','saved'),help=entry('payment-help','saved');
 let nav=move(emptyDialogs(),{type:'open',entry:draft});nav=move(nav,{type:'open',entry:help});
 assert.equal(dialogPath(currentDialog(nav),'/'),'/');nav=move(nav,{type:'back'});
 assert.equal(currentDialog(nav),draft);assert.equal(dialogPath(currentDialog(nav),'/'),'/#funding=saved');
 assert.equal(dialogPath(entry('order','saved'),'/'),'/?checkout=saved');
});
